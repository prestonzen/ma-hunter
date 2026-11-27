import { DEFAULT_UNDERWRITING, type Underwriting } from "../../shared/underwrite";
import { db, getSetting, parseJson, setSetting } from "./db";
import { comparables, fitQuant, lookAlike, tfidf, type QuantReport, type QuantRow } from "./quant";
import type { Env, QuantItem, QuantView, Valuation } from "./types";

/**
 * The quant layer's plumbing: read listings out of D1, fit (worker/src/quant.ts), keep the result.
 * A fit is stored, not recomputed per request: the report in settings, one row per listing in
 * `valuations`. The cron refits when the set of listings has changed.
 */

const MAX_ROWS = 3000;

type Row = Record<string, number | string | null>;

async function loadRows(env: Env): Promise<QuantRow[]> {
  const d = await db(env);
  // Removed and sold listings stay in: what they asked is still an observation of an asking multiple.
  const { results } = await d
    .prepare(
      `SELECT id, COALESCE(dupOf, id) AS grp, COALESCE(listedAt, firstSeen) AS t, askingPrice, COALESCE(cashFlow, ebitda) AS earnings, revenue, established, ownerHours,
              industry, model, source, sellerFinancing, ownerStays, remoteManageable
         FROM listings
        WHERE askingPrice > 0 AND COALESCE(cashFlow, ebitda) > 0
        ORDER BY COALESCE(listedAt, firstSeen) DESC LIMIT ?`,
    )
    .bind(MAX_ROWS)
    .all<Row>();
  return results.map((r) => ({
    id: Number(r.id), group: Number(r.grp), t: Number(r.t), ask: Number(r.askingPrice), earnings: Number(r.earnings),
    revenue: r.revenue == null ? null : Number(r.revenue), established: r.established == null ? null : Number(r.established), ownerHours: r.ownerHours == null ? null : Number(r.ownerHours),
    industry: (r.industry as string | null) ?? null, model: (r.model as string | null) ?? null, source: String(r.source),
    sellerFinancing: r.sellerFinancing === "yes", ownerStays: r.ownerStays === "yes" || r.ownerStays === "transition", remote: r.remoteManageable === "yes",
  }));
}

/** What a fit depends on. When it changes, the stored fit is stale. */
async function fingerprint(env: Env): Promise<string> {
  const r = await (await db(env))
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(askingPrice), 0) AS ask, COALESCE(SUM(COALESCE(cashFlow, ebitda)), 0) AS earn FROM listings WHERE askingPrice > 0 AND COALESCE(cashFlow, ebitda) > 0")
    .first<{ n: number; ask: number; earn: number }>();
  return `${r?.n ?? 0}:${r?.ask ?? 0}:${r?.earn ?? 0}`;
}

export async function refit(env: Env): Promise<{ report: QuantReport | null; priced: number }> {
  const now = Date.now();
  const rows = await loadRows(env);
  const fit = fitQuant(rows, now);
  const d = await db(env);
  const insert = d.prepare("INSERT INTO valuations (listingId, fair, low, high, gap, band, drivers, fitAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const stmts = [d.prepare("DELETE FROM valuations")];
  const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
  for (const v of fit?.values ?? []) stmts.push(insert.bind(v.id, r4(v.fair), r4(v.low), r4(v.high), r4(v.gap), v.band, JSON.stringify(v.drivers.map((x) => ({ name: x.name, effect: r4(x.effect) }))), now));
  for (let i = 0; i < stmts.length; i += 80) await d.batch(stmts.slice(i, i + 80));
  await setSetting(env, "quant_report", fit?.report ?? null);
  await setSetting(env, "quant_state", { fingerprint: await fingerprint(env), at: now, rows: rows.length });
  return { report: fit?.report ?? null, priced: fit?.values.length ?? 0 };
}

/** Cron: refit when listings were added or repriced, at most every few hours. */
export async function refitIfStale(env: Env, minHours = 6): Promise<boolean> {
  const state = await getSetting<{ fingerprint: string; at: number }>(env, "quant_state");
  if (state && Date.now() - state.at < minHours * 3_600_000) return false;
  if (state && state.fingerprint === (await fingerprint(env))) return false;
  await refit(env);
  return true;
}

export async function underwriting(env: Env): Promise<Underwriting> {
  return { ...DEFAULT_UNDERWRITING, ...((await getSetting<Partial<Underwriting>>(env, "underwriting")) ?? {}) };
}

export async function saveUnderwriting(env: Env, b: Partial<Underwriting>): Promise<Underwriting> {
  const cur = await underwriting(env);
  const num = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.max(lo, Math.min(hi, Number(v))) : d);
  const u: Underwriting = {
    downPct: num(b.downPct, 0, 100, cur.downPct), ratePct: num(b.ratePct, 0, 40, cur.ratePct), termYears: num(b.termYears, 1, 30, cur.termYears),
    closingPct: num(b.closingPct, 0, 30, cur.closingPct), replaceOwner: b.replaceOwner ?? cur.replaceOwner,
    managerSalary: num(b.managerSalary, 0, 1_000_000, cur.managerSalary), stressPct: num(b.stressPct, 0, 90, cur.stressPct),
  };
  await setSetting(env, "underwriting", u);
  return u;
}

// What a listing is (its model and industry) counts for more than how its description happens to be worded.
const docText = (r: Row) => `${r.title ?? ""} ${`${r.industry ?? ""} ${r.model ?? ""} `.repeat(3)}${String(r.description ?? "").slice(0, 600)}`;

/** Text and size of every listing, for similarity. Descriptions are cut short: the first lines carry what a listing is. */
async function corpus(env: Env): Promise<Row[]> {
  const { results } = await (await db(env))
    .prepare(
      `SELECT l.id, l.title, l.industry, l.model, substr(l.description, 1, 600) AS description, l.source, l.url, l.askingPrice, COALESCE(l.cashFlow, l.ebitda) AS earnings, l.ownerHours,
              l.stage, l.starred, l.status, v.fair, v.low, v.high, v.gap, v.band, v.drivers
         FROM listings l LEFT JOIN valuations v ON v.listingId = l.id
        WHERE l.dupOf IS NULL ORDER BY l.id DESC LIMIT ?`,
    )
    .bind(MAX_ROWS)
    .all<Row>();
  return results;
}

const PICKED = new Set(["shortlist", "contacted", "conversation", "nda", "review", "loi", "diligence", "closed"]);

const valuationOf = (r: Row): Valuation | null =>
  r.fair == null
    ? null
    : { fair: Number(r.fair), low: Number(r.low), high: Number(r.high), gap: Number(r.gap), band: r.band as Valuation["band"], drivers: parseJson<Valuation["drivers"]>(r.drivers, []) };

const item = (r: Row, like: number | null): QuantItem => ({
  id: Number(r.id), title: String(r.title), source: String(r.source), url: (r.url as string | null) ?? null, industry: (r.industry as string | null) ?? null, model: (r.model as string | null) ?? null,
  askingPrice: r.askingPrice == null ? null : Number(r.askingPrice), earnings: r.earnings == null ? null : Number(r.earnings), ownerHours: r.ownerHours == null ? null : Number(r.ownerHours),
  stage: String(r.stage) as QuantItem["stage"], starred: Number(r.starred ?? 0), status: String(r.status) as QuantItem["status"],
  valuation: valuationOf(r), like: like == null ? null : Math.round(like * 1000) / 1000,
});

/** The Valuation tab: the model report, every listing against it, and how close each is to the ones already picked. */
export async function quantView(env: Env): Promise<QuantView> {
  const rows = await corpus(env);
  const vecs = tfidf(rows.map(docText));
  const liked = rows.map((r, i) => (PICKED.has(String(r.stage)) || Number(r.starred) ? i : -1)).filter((i) => i >= 0);
  const passed = rows.map((r, i) => (r.stage === "passed" ? i : -1)).filter((i) => i >= 0);
  const like = lookAlike(vecs, liked, passed);
  const state = await getSetting<{ fingerprint: string; at: number }>(env, "quant_state");
  return {
    report: await getSetting<QuantReport>(env, "quant_report"),
    stale: !state || state.fingerprint !== (await fingerprint(env)),
    underwriting: await underwriting(env),
    picked: liked.length,
    items: rows.map((r, i) => item(r, like[i])).filter((x) => x.status !== "removed" && x.status !== "sold"),
  };
}

/** One listing: its valuation and the listings most like it. */
export async function listingValuation(env: Env, id: number): Promise<{ valuation: Valuation | null; comps: (QuantItem & { score: number })[]; underwriting: Underwriting; fitAt: number | null }> {
  const rows = await corpus(env);
  const at = rows.findIndex((r) => Number(r.id) === id);
  const report = await getSetting<QuantReport>(env, "quant_report");
  const base = { underwriting: await underwriting(env), fitAt: report?.fitAt ?? null };
  if (at < 0) return { valuation: null, comps: [], ...base };
  const vecs = tfidf(rows.map(docText));
  const comps = comparables(vecs, rows.map((r) => (r.earnings == null ? null : Number(r.earnings))), at).map((c) => ({ ...item(rows[c.index], null), score: Math.round(c.score * 100) / 100 }));
  return { valuation: valuationOf(rows[at]), comps, ...base };
}
