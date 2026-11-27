import assert from "node:assert/strict";
import { test } from "node:test";
import { annualPayment, DEFAULT_UNDERWRITING, underwrite } from "../shared/underwrite";
import {
  comparables, fitEncoder, fitGbt, fitQuant, fitRidge, groupFolds, lookAlike, quantile, rng, solveSpd, target, tfidf, usable, walkForwardSplits, type QuantRow,
} from "../worker/src/quant";

const NOW = Date.UTC(2026, 10, 27);
const DAY = 86_400_000;

/** Standard normal from a seeded generator (Box-Muller). */
const normal = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

const KINDS = [
  { model: "SaaS", lift: 0.45 },
  { model: "eCommerce", lift: 0 },
  { model: "Content", lift: -0.2 },
];

/** Listings whose multiple follows a known rule plus noise. `signal: false` makes the multiple pure noise. */
function synthetic(n: number, seed: number, signal = true): QuantRow[] {
  const rand = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const kind = KINDS[Math.floor(rand() * KINDS.length)];
    const earnings = Math.exp(11.5 + normal(rand));
    const margin = 0.15 + rand() * 0.5;
    const hours = Math.round(rand() * 50);
    const logMultiple = 1 + (signal ? kind.lift + 0.12 * (Math.log(earnings) - 11.5) + 0.5 * (margin - 0.4) - 0.004 * hours : 0) + 0.15 * normal(rand);
    return {
      id: i + 1, group: i + 1, t: NOW - (n - i) * DAY, ask: earnings * Math.exp(logMultiple), earnings, revenue: earnings / margin, established: 2005 + Math.floor(rand() * 18),
      ownerHours: hours, industry: null, model: kind.model, source: "test", sellerFinancing: rand() < 0.3, ownerStays: rand() < 0.5, remote: rand() < 0.6,
    };
  });
}

test("linear algebra: Cholesky solve and quantiles", () => {
  const x = solveSpd([[4, 2], [2, 3]], [10, 8]);
  assert.ok(Math.abs(x[0] - 1.75) < 1e-9 && Math.abs(x[1] - 1.5) < 1e-9);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.1), 1.4);
});

test("ridge recovers a linear rule", () => {
  const rand = rng(1);
  const X = Array.from({ length: 200 }, () => [normal(rand), normal(rand), normal(rand)]);
  const y = X.map((x) => 1 + 2 * x[0] - x[1] + 0.05 * normal(rand));
  const f = fitRidge(X, y);
  assert.ok(Math.abs(f.predict([1, 0, 0]) - 3) < 0.1);
  assert.ok(Math.abs(f.predict([0, 1, 0]) - 0) < 0.1);
  assert.ok(Math.abs(f.predict([0, 0, 1]) - 1) < 0.1, "a feature with no effect moves nothing");
});

test("boosted trees learn a step that a line cannot", () => {
  const rand = rng(2);
  const make = (n: number) => {
    const X = Array.from({ length: n }, () => [normal(rand), rand()]);
    return { X, y: X.map((x) => (x[0] > 0 ? 1 : 0) + (x[1] > 0.5 ? 0.5 : 0) + 0.05 * normal(rand)) };
  };
  const tr = make(300);
  const te = make(200);
  const mse = (predict: (x: number[]) => number) => te.X.reduce((s, x, i) => s + (te.y[i] - predict(x)) ** 2, 0) / te.X.length;
  const gbt = fitGbt(tr.X, tr.y);
  assert.ok(mse(gbt.predict) < 0.5 * mse(fitRidge(tr.X, tr.y).predict));
  assert.ok(gbt.gain[0] > gbt.gain[1], "the bigger step earns more of the gain");
});

test("walk-forward never trains on the future, and never on a copy of a test listing", () => {
  const rows = usable(synthetic(120, 3));
  rows[100].group = rows[10].group; // listing 101 is a cross-post of listing 11
  const splits = walkForwardSplits(rows);
  assert.equal(splits.length, 4);
  const tested = new Set<number>();
  for (const s of splits) {
    const lastTrain = Math.max(...s.train.map((i) => rows[i].t));
    const firstTest = Math.min(...s.test.map((i) => rows[i].t));
    assert.ok(lastTrain < firstTest);
    const groups = new Set(s.test.map((i) => rows[i].group));
    assert.ok(s.train.every((i) => !groups.has(rows[i].group)));
    s.test.forEach((i) => tested.add(i));
  }
  assert.equal(tested.size, 120 - Math.floor(120 * 0.4));
  assert.ok(!splits.find((s) => s.test.includes(100))!.train.includes(10));
});

test("grouped folds test every listing once and keep copies together", () => {
  const rows = usable(synthetic(90, 4));
  for (let i = 0; i < 30; i++) rows[i + 30].group = rows[i].group;
  const folds = groupFolds(rows);
  const seen = folds.flatMap((f) => f.test).sort((a, b) => a - b);
  assert.deepEqual(seen, rows.map((_, i) => i));
  for (const f of folds) {
    const groups = new Set(f.test.map((i) => rows[i].group));
    assert.ok(f.train.every((i) => !groups.has(rows[i].group)));
  }
});

test("the encoder learns its fill values and categories from the training rows only", () => {
  const rows = synthetic(100, 5);
  rows[0].revenue = null;
  const train = rows.slice(0, 60);
  const enc = fitEncoder(train, NOW);
  assert.ok(enc.names.includes("Model: SaaS"));
  assert.ok(enc.names.includes("Revenue (log): not stated"));
  // A category that only shows up later has no column, and encoding such a row still works.
  const later = { ...rows[80], model: "Marketplace" };
  assert.equal(enc.encode(later).length, enc.names.length);
  assert.ok(!enc.names.some((n) => n.includes("Marketplace")));
  assert.ok(!enc.names.some((n) => /days|online/i.test(n)), "time on market is not a feature");
});

test("a real pattern is found, beats the baseline, and a planted bargain is flagged", () => {
  const rows = synthetic(300, 6);
  rows[250].ask = rows[250].ask * 0.5;
  const fit = fitQuant(rows, NOW)!;
  const { report, values } = fit;
  assert.equal(report.n, 300);
  assert.notEqual(report.chosen, "median");
  const chosen = report.models.find((m) => m.name === report.chosen)!;
  assert.ok(chosen.skill > 0.3, `skill ${chosen.skill}`);
  assert.ok(report.vsBaseline.lo > 0, "the edge over the median is outside noise");
  assert.ok(chosen.mae < 0.2, "close to the noise that was put in (0.15 sd is 0.12 mean absolute)");
  assert.equal(report.models[0].skill, 0);
  assert.equal(chosen.blocks.length, 4);
  const planted = values.find((v) => v.id === rows[250].id)!;
  assert.equal(planted.band, "below");
  assert.ok(planted.gap < -0.35 && planted.gap > -0.65, `gap ${planted.gap}`);
  const within = values.filter((v) => v.band === "within").length / values.length;
  assert.ok(within > 0.74 && within < 0.86, `80% band holds ${within}`);
  assert.ok(report.drivers.some((d) => d.name === "Model: SaaS" && d.effect > 0.05));
  assert.ok(values.every((v) => v.low < v.fair && v.fair < v.high));
});

test("on pure noise the report doesn't pretend", () => {
  const { report } = fitQuant(synthetic(300, 7, false), NOW)!;
  const chosen = report.models.find((m) => m.name === report.chosen)!;
  assert.ok(chosen.skill < 0.08, `skill ${chosen.skill}`);
  assert.ok(report.notes.some((n) => /median|within noise/.test(n)));
  for (const m of report.models) assert.ok(m.skill < 0.08, `${m.name} ${m.skill}`);
});

test("a fit is reproducible, and too little data yields nothing", () => {
  const rows = synthetic(150, 8);
  assert.deepEqual(fitQuant(rows, NOW), fitQuant(rows, NOW));
  assert.equal(fitQuant(synthetic(40, 9), NOW), null);
  assert.equal(usable([{ ...rows[0], earnings: -5 }, { ...rows[1], ask: rows[1].earnings * 400 }]).length, 0);
  assert.ok(Math.abs(target({ ...rows[0], ask: 300, earnings: 100 }) - Math.log(3)) < 1e-12);
});

test("text similarity: comparables and look-alikes", () => {
  const docs = [
    "B2B SaaS invoicing software with monthly subscriptions",
    "SaaS subscription software for B2B scheduling",
    "Amazon FBA brand selling kitchen gadgets",
    "Amazon FBA brand selling pet supplies",
    "YouTube channel about woodworking with display advertising",
    "Medical supply distribution and logistics, B2B wholesale",
  ];
  const vecs = tfidf(docs);
  const comps = comparables(vecs, [100, 110, 100, 100, 100, 100], 0, 2);
  assert.equal(comps[0].index, 1);
  const scores = lookAlike(vecs, [0], [2]);
  const rank = scores.map((s, i) => ({ i, s: s! })).filter((x) => x.i !== 0).sort((a, b) => b.s - a.s);
  assert.equal(rank[0].i, 1, "the other SaaS listing is most like the pick");
  assert.ok(scores[3]! < scores[4]!, "another FBA listing is pushed down by the pass");
  assert.deepEqual(lookAlike(vecs, [], []), docs.map(() => null));
});

test("underwriting: debt service, coverage, the bad year and the cushion", () => {
  assert.ok(Math.abs(annualPayment(100_000, 12, 1) - 106_618.55) < 1);
  assert.equal(annualPayment(120_000, 0, 10), 12_000);
  const u = { ...DEFAULT_UNDERWRITING, downPct: 20, ratePct: 0, termYears: 10, closingPct: 5, managerSalary: 80_000, stressPct: 25 };
  const r = underwrite({ askingPrice: 1_000_000, earnings: 400_000, ownerHours: 20 }, u)!;
  assert.equal(r.ownerCost, 40_000);
  assert.equal(r.adjusted, 360_000);
  assert.equal(r.loan, 800_000);
  assert.equal(r.cashIn, 250_000);
  assert.equal(r.debtService, 80_000);
  assert.equal(r.dscr, 4.5);
  assert.equal(r.stressedDscr, (300_000 - 40_000) / 80_000);
  assert.ok(Math.abs(r.cushion - 0.7) < 1e-12);
  assert.ok(Math.abs(r.cashOnCash! - 280_000 / 250_000) < 1e-12);
  assert.equal(underwrite({ askingPrice: 1_000_000, earnings: 400_000, ownerHours: null }, u)!.hoursKnown, false);
  assert.equal(underwrite({ askingPrice: null, earnings: 400_000, ownerHours: 10 }, u), null);
  const thin = underwrite({ askingPrice: 1_000_000, earnings: 100_000, ownerHours: 40 }, u)!;
  assert.ok(thin.dscr! < 1 && thin.paybackYears === null && thin.cushion < 0);
});
