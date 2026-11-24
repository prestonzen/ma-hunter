import { db } from "./db";
import { STAGES, DAY } from "./types";
import type { Analytics, Env, PublicSummary, Stage } from "./types";

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 100) / 100;
};

export async function buildAnalytics(env: Env): Promise<Analytics> {
  const d = await db(env);
  const now = Date.now();
  type R = Record<string, number | string | null>;
  const [totals, byStage, bySource, rows, weeks, out, byStep, byClass, drops] = await d.batch<R>([
    d.prepare(
      `SELECT COUNT(*) AS listings, SUM(status = 'active') AS active, SUM(contactedAt IS NOT NULL) AS contacted, SUM(repliedAt IS NOT NULL) AS replied,
              SUM(stage IN ('conversation', 'nda', 'review', 'loi', 'diligence')) AS inPlay, AVG(CASE WHEN status = 'active' THEN fitScore END) AS avgFit,
              SUM(sellerFinancing = 'yes') AS sellerFinancing, SUM(ownerStays IN ('yes', 'transition')) AS ownerStays, SUM(remoteManageable = 'yes') AS remote
         FROM listings`,
    ),
    d.prepare("SELECT stage, COUNT(*) AS n FROM listings GROUP BY stage"),
    d.prepare("SELECT source, COUNT(*) AS n, SUM(contactedAt IS NOT NULL) AS contacted, SUM(repliedAt IS NOT NULL) AS replied FROM listings GROUP BY source ORDER BY n DESC"),
    d.prepare("SELECT industry, askingPrice, cashFlow, fitScore, COALESCE(listedAt, firstSeen) AS since FROM listings WHERE status = 'active' LIMIT 5000"),
    d.prepare("SELECT strftime('%Y-%m-%d', firstSeen / 1000, 'unixepoch', 'weekday 0', '-6 days') AS week, COUNT(*) AS n FROM listings WHERE firstSeen > ? GROUP BY week ORDER BY week").bind(now - 84 * DAY),
    d.prepare("SELECT SUM(direction = 'out' AND status = 'sent') AS sent, SUM(direction = 'in') AS replied, SUM(status IN ('draft', 'approved')) AS pending, SUM(status IN ('failed', 'needs_human')) AS failed FROM messages"),
    d.prepare(
      `SELECT m.step, COUNT(*) AS sent,
              SUM(EXISTS (SELECT 1 FROM messages r WHERE r.enrollmentId = m.enrollmentId AND r.direction = 'in' AND r.classification NOT IN ('auto_reply', 'bounce')
                           AND r.sentAt > m.sentAt AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.enrollmentId = m.enrollmentId AND n.direction = 'out' AND n.status = 'sent' AND n.sentAt > m.sentAt AND n.sentAt < r.sentAt))) AS replied
         FROM messages m WHERE m.direction = 'out' AND m.status = 'sent' AND m.enrollmentId IS NOT NULL GROUP BY m.step ORDER BY m.step`,
    ),
    d.prepare("SELECT classification, COUNT(*) AS n FROM messages WHERE direction = 'in' AND classification IS NOT NULL GROUP BY classification ORDER BY n DESC"),
    d.prepare("SELECT COUNT(DISTINCT listingId) AS n FROM events WHERE type = 'price' AND message LIKE '%dropped%' AND at > ?").bind(now - 30 * DAY),
  ]);

  const t = totals.results[0] ?? {};
  const stageCount = new Map(byStage.results.map((r) => [String(r.stage), Number(r.n)]));

  const industries = new Map<string, { n: number; multiples: number[]; fit: number }>();
  const buckets = [
    { bucket: "0-30 days", max: 30, n: 0 },
    { bucket: "31-90 days", max: 90, n: 0 },
    { bucket: "91-180 days", max: 180, n: 0 },
    { bucket: "181-365 days", max: 365, n: 0 },
    { bucket: "Over a year", max: Infinity, n: 0 },
  ];
  for (const r of rows.results) {
    const key = (r.industry as string | null) ?? "Not stated";
    const e = industries.get(key) ?? { n: 0, multiples: [], fit: 0 };
    e.n++;
    e.fit += Number(r.fitScore ?? 0);
    if (r.askingPrice && r.cashFlow && Number(r.cashFlow) > 0) e.multiples.push(Number(r.askingPrice) / Number(r.cashFlow));
    industries.set(key, e);
    const days = Math.max(0, (now - Number(r.since)) / DAY);
    buckets.find((b) => days <= b.max)!.n++;
  }

  return {
    totals: {
      listings: Number(t.listings ?? 0),
      active: Number(t.active ?? 0),
      contacted: Number(t.contacted ?? 0),
      replied: Number(t.replied ?? 0),
      inPlay: Number(t.inPlay ?? 0),
      avgFit: Math.round(Number(t.avgFit ?? 0)),
    },
    byStage: STAGES.map((stage) => ({ stage, n: stageCount.get(stage) ?? 0 })),
    bySource: bySource.results.map((r) => ({ source: String(r.source), n: Number(r.n), contacted: Number(r.contacted ?? 0), replied: Number(r.replied ?? 0) })),
    byIndustry: [...industries.entries()]
      .map(([industry, e]) => ({ industry, n: e.n, medianMultiple: median(e.multiples), avgFit: Math.round(e.fit / e.n) }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 15),
    daysOnline: buckets.map(({ bucket, n }) => ({ bucket, n })),
    newPerWeek: weeks.results.map((r) => ({ week: String(r.week), n: Number(r.n) })),
    outreach: {
      sent: Number(out.results[0]?.sent ?? 0),
      replied: Number(out.results[0]?.replied ?? 0),
      pending: Number(out.results[0]?.pending ?? 0),
      failed: Number(out.results[0]?.failed ?? 0),
      byStep: byStep.results.map((r) => ({ step: Number(r.step), sent: Number(r.sent), replied: Number(r.replied ?? 0) })),
      byClass: byClass.results.map((r) => ({ classification: String(r.classification), n: Number(r.n) })),
    },
    signals: {
      sellerFinancing: Number(t.sellerFinancing ?? 0),
      ownerStays: Number(t.ownerStays ?? 0),
      remote: Number(t.remote ?? 0),
      priceDrops: Number(drops.results[0]?.n ?? 0),
    },
  };
}

/**
 * The only data that is ever public: counts. No titles, prices, locations, contacts or notes, and
 * nothing at all unless PUBLIC_DASHBOARD is switched on.
 */
export async function publicSummary(env: Env, demo: boolean): Promise<PublicSummary> {
  const base = { enabled: env.PUBLIC_DASHBOARD === "true" || demo, demo, generatedAt: new Date().toISOString() };
  if (!base.enabled) return base;
  const d = await db(env);
  const [totals, byStage, bySource, byIndustry] = await d.batch<Record<string, number | string | null>>([
    d.prepare("SELECT COUNT(*) AS tracked, SUM(contactedAt IS NOT NULL) AS contacted, SUM(repliedAt IS NOT NULL) AS conversations, COUNT(DISTINCT source) AS sources FROM listings"),
    d.prepare("SELECT stage, COUNT(*) AS n FROM listings GROUP BY stage"),
    d.prepare("SELECT source, COUNT(*) AS n FROM listings GROUP BY source ORDER BY n DESC LIMIT 12"),
    d.prepare("SELECT industry, COUNT(*) AS n FROM listings WHERE industry IS NOT NULL GROUP BY industry HAVING n >= 3 ORDER BY n DESC LIMIT 10"),
  ]);
  const t = totals.results[0] ?? {};
  const stageCount = new Map(byStage.results.map((r) => [String(r.stage), Number(r.n)]));
  return {
    ...base,
    totals: { tracked: Number(t.tracked ?? 0), contacted: Number(t.contacted ?? 0), conversations: Number(t.conversations ?? 0), sources: Number(t.sources ?? 0) },
    byStage: STAGES.map((stage: Stage) => ({ stage, n: stageCount.get(stage) ?? 0 })),
    bySource: bySource.results.map((r) => ({ source: String(r.source), n: Number(r.n) })),
    byIndustry: byIndustry.results.map((r) => ({ industry: String(r.industry), n: Number(r.n) })),
  };
}
