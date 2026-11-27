/**
 * The quant layer: what multiple do listings like this one ask?
 *
 * Every listing with a price and a cash flow figure is an observation of an asking multiple. A model
 * fitted on the others says what this one "should" ask; the gap between that and what it does ask is
 * a reason to look closer (a bargain, or something the listing doesn't say).
 *
 * The rules this file keeps, because they are where valuation models usually cheat:
 *  - A listing is never priced by a model that saw it. Per-listing estimates are out-of-fold.
 *  - Models are compared walk-forward: fitted on older listings, tested on newer ones.
 *  - Copies of one business (cross-posted listings) never sit on both sides of a split.
 *  - Everything learned from data (medians for missing values, category lists, scaling) is learned
 *    from the training side only.
 *  - The complicated models have to beat the simple ones, and the report says so when they don't.
 *
 * Pure functions, no I/O, no dependencies: the Worker, the tests and a notebook can all call it.
 */

import type { ModelScore, QuantReport, QuantValue } from "../../shared/types";

export type { ModelScore, QuantReport, QuantValue };

export interface QuantRow {
  id: number;
  /** Listings that are the same business share a group. */
  group: number;
  /** When it was listed (ms). */
  t: number;
  ask: number;
  /** Annual cash flow (SDE) or EBITDA. */
  earnings: number;
  revenue: number | null;
  established: number | null;
  ownerHours: number | null;
  industry: string | null;
  model: string | null;
  source: string;
  sellerFinancing: boolean;
  ownerStays: boolean;
  remote: boolean;
}

/** The target: log of the asking multiple. Errors in it read as percentages. */
export const target = (r: QuantRow) => Math.log(r.ask / r.earnings);

// ---------- small numeric helpers ----------

/** Deterministic random numbers, so a fit is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const median = (xs: number[]) => quantile(xs, 0.5);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

// ---------- features ----------

export interface Encoder {
  names: string[];
  encode(r: QuantRow): number[];
}

const modelTokens = (m: string | null) => (m ?? "").split(/[,/|]/).map((x) => x.trim()).filter(Boolean);

/** The business model a listing leads with: the group for the "median of its kind" baseline. */
export const primaryModel = (r: QuantRow) => modelTokens(r.model)[0] ?? r.industry ?? "unknown";

/**
 * Turns listings into numbers. Fitted on training rows only: the medians that fill gaps and the list
 * of categories worth a column both come from them.
 *
 * Days on the market is deliberately not a feature. A listing lingers because it is overpriced, so
 * the feature would be an effect of the thing being predicted.
 */
export function fitEncoder(train: QuantRow[], now: number): Encoder {
  const year = new Date(now).getUTCFullYear();
  const age = (r: QuantRow) => (r.established ? Math.max(0, Math.min(40, year - r.established)) : null);
  const logRev = (r: QuantRow) => (r.revenue && r.revenue > 0 ? Math.log(r.revenue) : null);
  const margin = (r: QuantRow) => (r.revenue && r.revenue > 0 ? Math.max(0, Math.min(1.5, r.earnings / r.revenue)) : null);
  const hours = (r: QuantRow) => (r.ownerHours != null ? Math.max(0, Math.min(80, r.ownerHours)) : null);

  type Col = { name: string; get: (r: QuantRow) => number };
  const cols: Col[] = [{ name: "Earnings (log)", get: (r) => Math.log(r.earnings) }];

  const withGaps = (name: string, get: (r: QuantRow) => number | null) => {
    const seen = train.map(get).filter((v): v is number => v != null);
    if (!seen.length) return;
    const fill = median(seen);
    cols.push({ name, get: (r) => get(r) ?? fill });
    if (seen.length < train.length) cols.push({ name: `${name}: not stated`, get: (r) => (get(r) == null ? 1 : 0) });
  };
  withGaps("Revenue (log)", logRev);
  withGaps("Margin", margin);
  withGaps("Years in business", age);
  withGaps("Owner hours a week", hours);

  const flag = (name: string, get: (r: QuantRow) => boolean) => {
    const n = train.filter(get).length;
    if (n >= 3 && n <= train.length - 3) cols.push({ name, get: (r) => (get(r) ? 1 : 0) });
  };
  flag("Seller financing", (r) => r.sellerFinancing);
  flag("Owner stays on", (r) => r.ownerStays);
  flag("Runs remotely", (r) => r.remote);

  // A category gets a column once enough listings carry it; rarer ones share the baseline.
  const min = Math.max(5, Math.ceil(train.length * 0.03));
  const category = (label: string, values: (r: QuantRow) => string[]) => {
    const counts = new Map<string, number>();
    for (const r of train) for (const v of new Set(values(r))) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const [v, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (n < min || n > train.length - 3) continue;
      cols.push({ name: `${label}: ${v}`, get: (r) => (values(r).includes(v) ? 1 : 0) });
    }
  };
  category("Model", (r) => modelTokens(r.model));
  category("Industry", (r) => (r.industry ? [r.industry] : []));
  category("Source", (r) => [r.source]);

  return { names: cols.map((c) => c.name), encode: (r) => cols.map((c) => c.get(r)) };
}

interface Scaler {
  mu: number[];
  sd: number[];
  apply(x: number[]): number[];
}

function fitScaler(X: number[][]): Scaler {
  const p = X[0]?.length ?? 0;
  const mu = Array.from({ length: p }, (_, j) => mean(X.map((x) => x[j])));
  const sd = Array.from({ length: p }, (_, j) => Math.sqrt(mean(X.map((x) => (x[j] - mu[j]) ** 2))) || 1);
  return { mu, sd, apply: (x) => x.map((v, j) => (v - mu[j]) / sd[j]) };
}

// ---------- models ----------

export type Predictor = (x: number[], r: QuantRow) => number;

export interface Model {
  name: string;
  label: string;
  fit(X: number[][], y: number[], rows: QuantRow[]): Predictor;
}

/** Baseline: every listing asks the median multiple. */
export const medianModel: Model = {
  name: "median",
  label: "Median multiple",
  fit: (_X, y) => {
    const m = median(y);
    return () => m;
  },
};

/** Baseline: the median multiple of its business model, pulled toward the overall median when the group is small. */
export const groupModel: Model = {
  name: "group",
  label: "Median of its kind",
  fit: (_X, y, rows) => {
    const all = median(y);
    const by = new Map<string, number[]>();
    rows.forEach((r, i) => by.set(primaryModel(r), [...(by.get(primaryModel(r)) ?? []), y[i]]));
    const K = 5;
    const est = new Map([...by.entries()].map(([g, ys]) => [g, (ys.length * median(ys) + K * all) / (ys.length + K)]));
    return (_x, r) => est.get(primaryModel(r)) ?? all;
  },
};

/** Comparables, the way a broker does it: the nearest listings by their numbers, weighted by closeness. */
export const knnModel: Model = {
  name: "knn",
  label: "Nearest comparables",
  fit: (X, y) => {
    const sc = fitScaler(X);
    const Z = X.map(sc.apply);
    const k = Math.min(7, Z.length);
    return (x) => {
      const z = sc.apply(x);
      const d = Z.map((zi, i) => ({ i, d: Math.sqrt(zi.reduce((s, v, j) => s + (v - z[j]) ** 2, 0)) }));
      d.sort((a, b) => a.d - b.d);
      let num = 0;
      let den = 0;
      for (const { i, d: dist } of d.slice(0, k)) {
        const w = 1 / (dist + 0.25);
        num += w * y[i];
        den += w;
      }
      return num / den;
    };
  },
};

/** Solve A x = b for a symmetric positive-definite A (Cholesky). */
export function solveSpd(A: number[][], b: number[]): number[] {
  const n = b.length;
  const L = A.map((r) => r.slice());
  for (let j = 0; j < n; j++) {
    let s = L[j][j];
    for (let k = 0; k < j; k++) s -= L[j][k] * L[j][k];
    const d = Math.sqrt(Math.max(s, 1e-12));
    L[j][j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = L[i][j];
      for (let k = 0; k < j; k++) t -= L[i][k] * L[j][k];
      L[i][j] = t / d;
    }
  }
  const z = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * z[k];
    z[i] = s / L[i][i];
  }
  const x = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

export interface RidgeFit {
  intercept: number;
  /** Per standard deviation of each feature. */
  beta: number[];
  lambda: number;
  scaler: Scaler;
  predict(x: number[]): number;
}

function ridgeAt(Z: number[][], yc: number[], lambda: number): number[] {
  const p = Z[0]?.length ?? 0;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < Z.length; i++) {
    const z = Z[i];
    for (let j = 0; j < p; j++) {
      b[j] += z[j] * yc[i];
      for (let k = 0; k <= j; k++) A[j][k] += z[j] * z[k];
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) A[k][j] = A[j][k];
    A[j][j] += lambda;
  }
  return p ? solveSpd(A, b) : [];
}

const LAMBDAS = [0.3, 1, 3, 10, 30, 100];

/** Ridge regression on standardised features. The penalty is picked by cross-validation inside the training rows. */
export function fitRidge(X: number[][], y: number[], seed = 3): RidgeFit {
  const scaler = fitScaler(X);
  const Z = X.map(scaler.apply);
  const intercept = mean(y);
  const yc = y.map((v) => v - intercept);
  let lambda = 10;
  if (Z.length >= 30) {
    const rand = rng(seed);
    const fold = Z.map(() => Math.floor(rand() * 4));
    let best = Infinity;
    for (const lam of LAMBDAS) {
      let err = 0;
      for (let f = 0; f < 4; f++) {
        const tr = Z.map((_, i) => i).filter((i) => fold[i] !== f);
        const m = mean(tr.map((i) => yc[i]));
        const beta = ridgeAt(tr.map((i) => Z[i]), tr.map((i) => yc[i] - m), lam);
        for (let i = 0; i < Z.length; i++) if (fold[i] === f) err += Math.abs(yc[i] - m - Z[i].reduce((s, v, j) => s + v * beta[j], 0));
      }
      // A stronger penalty has to lose clearly before a weaker one is taken.
      if (err < best * 0.995) {
        best = err;
        lambda = lam;
      }
    }
  }
  const beta = ridgeAt(Z, yc, lambda);
  return { intercept, beta, lambda, scaler, predict: (x) => intercept + scaler.apply(x).reduce((s, v, j) => s + v * beta[j], 0) };
}

export const ridgeModel: Model = {
  name: "ridge",
  label: "Ridge regression",
  fit: (X, y) => {
    const f = fitRidge(X, y);
    return (x) => f.predict(x);
  },
};

interface TreeNode {
  /** Feature index, or -1 for a leaf. */
  f: number;
  thr: number;
  l: number;
  r: number;
  v: number;
}

export interface GbtFit {
  base: number;
  rate: number;
  trees: TreeNode[][];
  /** Total squared-error reduction credited to each feature. */
  gain: number[];
  predict(x: number[]): number;
}

export const GBT = { rounds: 120, rate: 0.08, depth: 2, minLeaf: 5, subsample: 0.8, seed: 7 };

/**
 * Gradient-boosted regression trees, squared loss. Small on purpose: shallow trees, a slow learning
 * rate, a minimum leaf size. The settings are fixed rather than tuned, so no test data leaks into them.
 */
export function fitGbt(X: number[][], y: number[], o = GBT): GbtFit {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  const base = mean(y);
  const pred = new Array<number>(n).fill(base);
  const gain = new Array<number>(p).fill(0);
  // Row order by each feature, worked out once.
  const order = Array.from({ length: p }, (_, j) => X.map((_, i) => i).sort((a, b) => X[a][j] - X[b][j]));
  const rand = rng(o.seed);
  const trees: TreeNode[][] = [];
  const node = new Int32Array(n);
  const res = new Float64Array(n);

  for (let round = 0; round < o.rounds; round++) {
    for (let i = 0; i < n; i++) {
      res[i] = y[i] - pred[i];
      node[i] = rand() < o.subsample ? 0 : -1;
    }
    const tree: TreeNode[] = [];
    const grow = (id: number, depth: number): number => {
      let cnt = 0;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        if (node[i] !== id) continue;
        cnt++;
        sum += res[i];
      }
      const self = tree.length;
      tree.push({ f: -1, thr: 0, l: -1, r: -1, v: cnt ? sum / cnt : 0 });
      if (depth >= o.depth || cnt < 2 * o.minLeaf) return self;
      let best = { gain: 1e-9, f: -1, thr: 0 };
      for (let j = 0; j < p; j++) {
        let nl = 0;
        let sl = 0;
        let prev = NaN;
        for (const i of order[j]) {
          if (node[i] !== id) continue;
          const v = X[i][j];
          if (nl >= o.minLeaf && cnt - nl >= o.minLeaf && v !== prev) {
            const g = (sl * sl) / nl + ((sum - sl) * (sum - sl)) / (cnt - nl) - (sum * sum) / cnt;
            if (g > best.gain) best = { gain: g, f: j, thr: (v + prev) / 2 };
          }
          nl++;
          sl += res[i];
          prev = v;
        }
      }
      if (best.f < 0) return self;
      gain[best.f] += best.gain;
      // Heap numbering: a node's children get ids no other node uses. Rows left out of this round stay at -1.
      const lid = id * 2 + 1;
      const rid = id * 2 + 2;
      for (let i = 0; i < n; i++) if (node[i] === id) node[i] = X[i][best.f] <= best.thr ? lid : rid;
      tree[self].f = best.f;
      tree[self].thr = best.thr;
      tree[self].l = grow(lid, depth + 1);
      tree[self].r = grow(rid, depth + 1);
      return self;
    };
    grow(0, 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) pred[i] += o.rate * walk(tree, X[i]);
  }
  return { base, rate: o.rate, trees, gain, predict: (x) => trees.reduce((s, t) => s + o.rate * walk(t, x), base) };
}

function walk(tree: TreeNode[], x: number[]): number {
  let k = 0;
  while (tree[k].f >= 0) k = x[tree[k].f] <= tree[k].thr ? tree[k].l : tree[k].r;
  return tree[k].v;
}

export const gbtModel: Model = {
  name: "gbt",
  label: "Gradient-boosted trees",
  fit: (X, y) => {
    const f = fitGbt(X, y);
    return (x) => f.predict(x);
  },
};

/** Simplest first. A later model has to beat an earlier one by a margin to be used. */
export const MODELS: Model[] = [medianModel, groupModel, knnModel, ridgeModel, gbtModel];

// ---------- validation ----------

export interface Split {
  train: number[];
  test: number[];
}

/**
 * Walk-forward splits over rows sorted oldest first: train on everything listed before a block, test
 * on the block. Training rows that are the same business as a test row are dropped (purged).
 */
export function walkForwardSplits(rows: QuantRow[], blocks = 4, minTrain = 0.4): Split[] {
  const n = rows.length;
  const start = Math.floor(n * minTrain);
  const size = (n - start) / blocks;
  const out: Split[] = [];
  for (let b = 0; b < blocks; b++) {
    const from = Math.round(start + b * size);
    const to = b === blocks - 1 ? n : Math.round(start + (b + 1) * size);
    if (to <= from) continue;
    const test = Array.from({ length: to - from }, (_, i) => from + i);
    const groups = new Set(test.map((i) => rows[i].group));
    const train = Array.from({ length: from }, (_, i) => i).filter((i) => !groups.has(rows[i].group));
    out.push({ train, test });
  }
  return out;
}

/** K folds that keep each group whole. */
export function groupFolds(rows: QuantRow[], k = 5, seed = 11): Split[] {
  const groups = [...new Set(rows.map((r) => r.group))].sort((a, b) => a - b);
  const rand = rng(seed);
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }
  const foldOf = new Map(groups.map((g, i) => [g, i % k]));
  return Array.from({ length: k }, (_, f) => ({
    train: rows.map((_, i) => i).filter((i) => foldOf.get(rows[i].group) !== f),
    test: rows.map((_, i) => i).filter((i) => foldOf.get(rows[i].group) === f),
  })).filter((s) => s.test.length && s.train.length);
}

/** Fit each model on a split's training rows and predict its test rows. The encoder is fitted on the training rows too. */
function runSplit(rows: QuantRow[], split: Split, models: Model[], now: number): Map<string, number[]> {
  const tr = split.train.map((i) => rows[i]);
  const enc = fitEncoder(tr, now);
  const X = tr.map(enc.encode);
  const y = tr.map(target);
  const out = new Map<string, number[]>();
  for (const m of models) {
    const predict = m.fit(X, y, tr);
    out.set(m.name, split.test.map((i) => predict(enc.encode(rows[i]), rows[i])));
  }
  return out;
}

export const MIN_ROWS = 60;

/** Keep the rows a multiple model can use, oldest first. */
export function usable(rows: QuantRow[]): QuantRow[] {
  return rows
    .filter((r) => r.ask > 0 && r.earnings > 0 && Number.isFinite(r.t))
    .filter((r) => {
      const m = r.ask / r.earnings;
      return m >= 0.2 && m <= 30;
    })
    .sort((a, b) => a.t - b.t || a.id - b.id);
}

/**
 * The whole procedure: compare the models walk-forward, pick one, price every listing out-of-fold,
 * and describe what the fit leans on. Returns null when there is too little data to say anything.
 */
export function fitQuant(input: QuantRow[], now: number, models: Model[] = MODELS): { report: QuantReport; values: QuantValue[] } | null {
  const rows = usable(input);
  if (rows.length < MIN_ROWS) return null;
  const y = rows.map(target);

  // 1. Walk-forward comparison.
  const splits = walkForwardSplits(rows);
  const errs = new Map<string, number[]>(models.map((m) => [m.name, []]));
  const blocks = new Map<string, number[]>(models.map((m) => [m.name, []]));
  for (const s of splits) {
    const preds = runSplit(rows, s, models, now);
    for (const m of models) {
      const e = preds.get(m.name)!.map((p, k) => Math.abs(y[s.test[k]] - p));
      errs.get(m.name)!.push(...e);
      blocks.get(m.name)!.push(mean(e));
    }
  }
  const baseMae = mean(errs.get(models[0].name)!);
  const scores: ModelScore[] = models.map((m) => {
    const e = errs.get(m.name)!;
    return { name: m.name, label: m.label, mae: mean(e), mdape: median(e.map((v) => Math.exp(v) - 1)), skill: baseMae > 0 ? 1 - mean(e) / baseMae : 0, blocks: blocks.get(m.name)! };
  });
  let chosen = scores[0];
  for (const s of scores.slice(1)) if (s.mae < chosen.mae * 0.98) chosen = s;

  // Is the improvement over the baseline more than noise? Resample the test errors, paired.
  const a = errs.get(models[0].name)!;
  const b = errs.get(chosen.name)!;
  const rand = rng(23);
  const diffs: number[] = [];
  for (let k = 0; k < 1000; k++) {
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      const j = Math.floor(rand() * a.length);
      d += a[j] - b[j];
    }
    diffs.push(d / a.length);
  }
  const vsBaseline = { diff: baseMae - chosen.mae, lo: quantile(diffs, 0.025), hi: quantile(diffs, 0.975) };

  // 2. Out-of-fold estimate for every listing, from the chosen model.
  const model = models.find((m) => m.name === chosen.name)!;
  const oof = new Array<number>(rows.length).fill(NaN);
  for (const s of groupFolds(rows)) {
    const p = runSplit(rows, s, [model], now).get(model.name)!;
    s.test.forEach((i, k) => (oof[i] = p[k]));
  }
  const resid = rows.map((_, i) => y[i] - oof[i]).filter(Number.isFinite);
  const band = { lo: quantile(resid, 0.1), hi: quantile(resid, 0.9) };

  // 3. What the fit leans on, from models fitted on everything.
  const enc = fitEncoder(rows, now);
  const X = rows.map(enc.encode);
  const ridge = fitRidge(X, y);
  const gbt = fitGbt(X, y);
  const totalGain = gbt.gain.reduce((s, g) => s + g, 0) || 1;
  const pct = (logEffect: number) => Math.exp(logEffect) - 1;
  const drivers = enc.names.map((name, j) => ({ name, effect: pct(ridge.beta[j]) })).sort((p, q) => Math.abs(q.effect) - Math.abs(p.effect)).slice(0, 12);
  const importance = enc.names.map((name, j) => ({ name, share: gbt.gain[j] / totalGain })).filter((f) => f.share > 0.005).sort((p, q) => q.share - p.share).slice(0, 12);

  // A yes/no feature the listing lacks reads as "Not ...", so the driver says which way it cuts.
  const yesNo = enc.names.map((_, j) => X.every((x) => x[j] === 0 || x[j] === 1));
  const values: QuantValue[] = rows.map((r, i) => {
    const z = ridge.scaler.apply(X[i]);
    const gap = Math.exp(y[i] - oof[i]) - 1;
    const d = y[i] - oof[i];
    return {
      id: r.id,
      fair: Math.exp(oof[i]),
      low: Math.exp(oof[i] + band.lo),
      high: Math.exp(oof[i] + band.hi),
      gap,
      band: d < band.lo ? "below" : d > band.hi ? "above" : "within",
      drivers: enc.names.map((name, j) => ({ name: yesNo[j] && X[i][j] === 0 ? `Not ${name.replace(/^(Model|Industry|Source): /, "")}` : name.replace(/^(Model|Industry|Source): /, ""), effect: pct(z[j] * ridge.beta[j]) })).sort((p, q) => Math.abs(q.effect) - Math.abs(p.effect)).slice(0, 3).filter((f) => Math.abs(f.effect) >= 0.01),
    };
  });

  const notes = [
    "Fitted on asking prices, not sale prices: it says what similar listings ask, not what they sell for.",
    "The sample is what is listed today. Old listings in it are the ones that have not sold, which tilts it toward the overpriced.",
  ];
  if (chosen.name === models[0].name) notes.push("No model beat the median multiple out of sample, so the median is what is used.");
  else if (vsBaseline.lo <= 0) notes.push("The chosen model's edge over the median is within noise on this sample.");
  if (new Set(rows.map((r) => r.source)).size === 1) notes.push(`Every listing is from one marketplace (${rows[0].source}), so the fit reflects how that marketplace prices.`);

  return {
    report: {
      fitAt: now, n: rows.length, tested: a.length, from: rows[0].t, to: rows[rows.length - 1].t,
      features: enc.names, models: scores, chosen: chosen.name, vsBaseline, band, drivers, importance, ridgeLambda: ridge.lambda, notes,
    },
    values,
  };
}

// ---------- text similarity: comparables and look-alikes ----------

const STOP = new Set(
  "the and for with that this from are was has have had its our you your their they will can all any not but per who how what when which while into over under more most very also been being than then them these those such each other about after before between both during only own same too just out off via".split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
}

export type Vec = Map<string, number>;

/** TF-IDF vectors, length-normalised, so a dot product is a cosine similarity. */
export function tfidf(docs: string[]): Vec[] {
  const tokens = docs.map(tokenize);
  const df = new Map<string, number>();
  for (const t of tokens) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length;
  return tokens.map((t) => {
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    const v: Vec = new Map();
    let norm = 0;
    for (const [w, c] of tf) {
      const d = df.get(w) ?? 1;
      // A word every listing uses says nothing; one only this listing uses can't match anything.
      if (d < 2 && n > 2) continue;
      const x = (1 + Math.log(c)) * Math.log((n + 1) / (d + 0.5));
      v.set(w, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  });
}

export function cosine(a: Vec, b: Vec): number {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [w, x] of s) {
    const y = l.get(w);
    if (y) dot += x * y;
  }
  return dot;
}

export function centroid(vs: Vec[]): Vec {
  const c: Vec = new Map();
  for (const v of vs) for (const [w, x] of v) c.set(w, (c.get(w) ?? 0) + x);
  let norm = 0;
  for (const x of c.values()) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (const [w, x] of c) c.set(w, x / norm);
  return c;
}

/**
 * "More like the ones I picked" (Rocchio relevance feedback): closeness to the listings you moved
 * forward, less half the closeness to the ones you passed on. Null when nothing has been picked yet.
 */
export function lookAlike(vecs: Vec[], liked: number[], passed: number[]): (number | null)[] {
  if (!liked.length) return vecs.map(() => null);
  const pos = centroid(liked.map((i) => vecs[i]));
  const neg = passed.length ? centroid(passed.map((i) => vecs[i])) : null;
  return vecs.map((v) => cosine(v, pos) - (neg ? 0.5 * cosine(v, neg) : 0));
}

/** Comparable listings: similar in what they are (text) and in size (earnings). */
export function comparables(vecs: Vec[], earnings: (number | null)[], target: number, k = 5): { index: number; score: number }[] {
  const e0 = earnings[target];
  return vecs
    .map((v, i) => {
      if (i === target) return { index: i, score: -1 };
      const text = cosine(v, vecs[target]);
      const e = earnings[i];
      const size = e0 && e && e0 > 0 && e > 0 ? Math.exp(-Math.abs(Math.log(e / e0))) : 0.3;
      return { index: i, score: 0.65 * text + 0.35 * size * (text > 0 ? 1 : 0.5) };
    })
    .filter((c) => c.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
