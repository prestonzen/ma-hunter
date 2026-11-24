import { db, logEvent, parseJson } from "./db";
import { upsertListings } from "./listings";
import { ALERT_DOMAINS, LISTING_URL, decodeEntities, pageFromHtml, parseAlertEmail, parseListingPage, sourceFromUrl, type AlertEmail, type PagePayload } from "./parse";
import { HOUR, HttpError } from "./types";
import type { Env, ListingInput, SavedSearch } from "./types";

/**
 * Where listings come from. Each marketplace gets the channel that actually works for it:
 *
 *   empireflippers  public JSON API, fetched by the Worker on a cron.
 *   flippa          Flippa's API with your own access token (FLIPPA_TOKEN secret).
 *   url             any page the Worker is allowed to fetch (Quiet Light, Website Closers, FE International,
 *                   BusinessesForSale.com ...): JSON-LD plus labelled fields.
 *   browser         a marketplace search page opened by the browser runner in a real, signed-in Chrome
 *                   (BizBuySell, BizQuest, Flippa search, LoopNet ...). Those sites refuse server-side
 *                   requests, so the runner reads the pages and posts them here to be parsed.
 *   alerts          saved-search alert emails, forwarded by the Gmail bridge.
 *   clipper / agents / manual entry: see index.ts.
 */

export const SOURCE_KINDS = ["empireflippers", "flippa", "url", "browser"] as const;

const UA = "Mozilla/5.0 (compatible; MAHunter/0.1; +https://github.com/prestonzen/ma-hunter)";

// ---------- Empire Flippers ----------

interface EfListing {
  listing_number: number;
  public_title: string;
  summary?: string | null;
  listing_price?: number | null;
  average_annual_gross_revenue?: number | null;
  average_annual_net_profit?: number | null;
  average_monthly_net_profit?: number | null;
  average_monthly_gross_revenue?: number | null;
  country?: string | null;
  first_made_money_at?: string | null;
  first_listed_at?: string | null;
  listing_status?: string | null;
  hours_worked_per_week?: number | null;
  reason_for_sale?: string | null;
  seller_support?: string | null;
  private_lender_approved?: boolean | null;
  niches?: { niche: string }[];
  monetizations?: { monetization: string }[];
  opportunities?: string[];
  risks?: string[];
  work_required?: string[];
}

export function mapEmpireFlippers(l: EfListing): ListingInput {
  const hours = l.hours_worked_per_week ?? null;
  const extra = [
    l.work_required?.length ? `Work required: ${l.work_required.join("; ")}.` : "",
    l.opportunities?.length ? `Opportunities: ${l.opportunities.join("; ")}.` : "",
    l.risks?.length ? `Risks: ${l.risks.join(" ")}` : "",
  ].filter(Boolean);
  const status = (l.listing_status ?? "").toLowerCase();
  return {
    source: "empireflippers",
    sourceId: String(l.listing_number),
    url: `https://empireflippers.com/listing/${l.listing_number}/`,
    title: decodeEntities(l.public_title ?? `Listing #${l.listing_number}`),
    description: decodeEntities([l.summary ?? "", ...extra].join("\n\n")).slice(0, 5800),
    industry: l.niches?.[0]?.niche ?? null,
    model: l.monetizations?.map((m) => m.monetization).join(", ") || null,
    country: l.country ?? null,
    location: l.country ? `Online (${l.country})` : "Online",
    askingPrice: l.listing_price ?? null,
    revenue: l.average_annual_gross_revenue ?? (l.average_monthly_gross_revenue ? l.average_monthly_gross_revenue * 12 : null),
    cashFlow: l.average_annual_net_profit ?? (l.average_monthly_net_profit ? l.average_monthly_net_profit * 12 : null),
    established: l.first_made_money_at ? Number(l.first_made_money_at.slice(0, 4)) || null : null,
    listedAt: l.first_listed_at ? Date.parse(l.first_listed_at) || null : null,
    reasonForSelling: l.reason_for_sale ?? null,
    transitionNotes: l.seller_support ?? null,
    ownerStays: l.seller_support ? "transition" : "unknown",
    ownerHours: hours,
    ownerRole: hours == null ? "unknown" : hours <= 5 ? "absentee" : hours <= 20 ? "semi" : "operator",
    remoteManageable: "yes",
    sbaEligible: l.private_lender_approved ? "yes" : "unknown",
    financingNotes: l.private_lender_approved ? "Approved for private-lender financing through Empire Flippers." : null,
    status: status.includes("sold") ? "sold" : status.includes("pending") || status.includes("offer") ? "pending" : "active",
  };
}

/** One page (100 listings) per run; the cursor walks through the catalogue across cron ticks. */
async function runEmpireFlippers(env: Env, s: SavedSearch): Promise<{ count: number; created: number; cursor: string | null }> {
  const page = Math.max(1, Number(s.cursor) || 1);
  const params = new URLSearchParams({ limit: "100", page: String(page), listing_status: "For Sale", sort: "first_listed_at", order: "DESC" });
  for (const [k, v] of Object.entries(parseJson<Record<string, string | number>>(s.query, {}))) params.set(k, String(v));
  const res = await fetch(`https://api.empireflippers.com/api/v1/listings/list?${params}`, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (!res.ok) throw new Error(`Empire Flippers API answered ${res.status}`);
  const j = (await res.json()) as { data?: { listings?: EfListing[]; pages?: number } };
  const listings = j.data?.listings ?? [];
  const r = await upsertListings(env, listings.filter((l) => l.listing_number && l.public_title).map(mapEmpireFlippers), "empireflippers");
  const pages = j.data?.pages ?? page;
  return { count: listings.length, created: r.created, cursor: page < pages && listings.length ? String(page + 1) : null };
}

// ---------- Flippa ----------

type FlippaItem = Record<string, unknown> & { attributes?: Record<string, unknown> };

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[$,]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Flippa's v3 API has returned both flat objects and JSON:API `attributes`; read either. */
export function mapFlippa(item: FlippaItem): ListingInput | null {
  const a = { ...item, ...(item.attributes ?? {}) } as Record<string, unknown>;
  const id = text(a.id) ?? (typeof a.id === "number" ? String(a.id) : null);
  const title = text(a.title) ?? text(a.property_name) ?? text(a.hostname);
  if (!id || !title) return null;
  const monthlyProfit = num(a.profit_per_month) ?? num(a.average_profit) ?? num(a.net_profit_per_month);
  const monthlyRevenue = num(a.revenue_per_month) ?? num(a.average_revenue);
  const status = (text(a.status) ?? "").toLowerCase();
  return {
    source: "flippa",
    sourceId: id,
    url: text(a.html_url) ?? text(a.listing_url) ?? `https://flippa.com/${id}`,
    title,
    description: [text(a.summary), text(a.description)].filter(Boolean).join("\n\n").slice(0, 5800) || null,
    industry: text(a.industry) ?? text(a.category) ?? null,
    model: text(a.monetization) ?? text(a.business_model) ?? text(a.property_type) ?? null,
    country: text(a.country_name) ?? text(a.country) ?? null,
    location: "Online",
    askingPrice: num(a.buy_it_now_price) ?? num(a.asking_price) ?? num(a.current_price) ?? num(a.price),
    revenue: monthlyRevenue ? monthlyRevenue * 12 : num(a.annual_revenue),
    cashFlow: monthlyProfit ? monthlyProfit * 12 : num(a.annual_profit),
    established: text(a.established_at) ? Number(String(a.established_at).slice(0, 4)) || null : null,
    listedAt: text(a.starts_at) ? Date.parse(String(a.starts_at)) || null : text(a.created_at) ? Date.parse(String(a.created_at)) || null : null,
    remoteManageable: "yes",
    status: /sold|won|closed|ended/.test(status) ? "sold" : "active",
  };
}

async function runFlippa(env: Env, s: SavedSearch): Promise<{ count: number; created: number; cursor: string | null }> {
  if (!env.FLIPPA_TOKEN) throw new Error("Set the FLIPPA_TOKEN secret (your Flippa API access token), or use a browser search for Flippa instead");
  const page = Math.max(1, Number(s.cursor) || 1);
  const params = new URLSearchParams({ "filter[status]": "open", "page[size]": "100", "page[number]": String(page) });
  for (const [k, v] of Object.entries(parseJson<Record<string, string | number>>(s.query, {}))) params.set(k, String(v));
  const res = await fetch(`https://flippa.com/v3/listings?${params}`, { headers: { Accept: "application/json", Authorization: `Bearer ${env.FLIPPA_TOKEN}`, "User-Agent": UA } });
  if (res.status === 401 || res.status === 403) throw new Error(`Flippa rejected the token (${res.status}). Check FLIPPA_TOKEN, or use a browser search for Flippa instead`);
  if (!res.ok) throw new Error(`Flippa API answered ${res.status}`);
  const j = (await res.json()) as { data?: FlippaItem[] } | FlippaItem[];
  const items = Array.isArray(j) ? j : (j.data ?? []);
  const mapped = items.map(mapFlippa).filter((x): x is ListingInput => !!x);
  const r = await upsertListings(env, mapped, "flippa");
  return { count: mapped.length, created: r.created, cursor: items.length >= 100 && page < 20 ? String(page + 1) : null };
}

// ---------- generic URL import ----------

async function fetchPage(url: string): Promise<PagePayload> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, "that isn't a valid URL");
  }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, "only http(s) URLs can be imported");
  const res = await fetch(u.toString(), { headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": UA }, redirect: "follow" });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    throw new HttpError(422, `${u.hostname} refuses server-side requests (${res.status}). Open the page in your browser and use the clipper, or add it as a browser search for the runner.`);
  }
  if (!res.ok) throw new HttpError(502, `${u.hostname} answered ${res.status}`);
  const html = (await res.text()).slice(0, 3_000_000);
  return pageFromHtml(res.url || u.toString(), html);
}

/** Fetch one listing page and return what the parser makes of it, without saving. */
export async function previewUrl(url: string): Promise<ListingInput> {
  return parseListingPage(await fetchPage(url));
}

/** Links on a search-results page that look like individual listings on the same site. */
export function listingLinks(pageUrl: string, html: string, max = 40): string[] {
  const base = new URL(pageUrl);
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(decodeEntities(m[1]), base);
    } catch {
      continue;
    }
    if (u.hostname !== base.hostname || u.pathname === base.pathname) continue;
    const path = u.pathname.toLowerCase();
    if (/\.(?:png|jpe?g|gif|svg|css|js|pdf|xml)$/.test(path)) continue;
    // The big marketplaces have known listing-URL shapes; everything else goes by the path's look.
    if (LISTING_URL.test(u.origin + u.pathname)) {
      u.search = "";
      u.hash = "";
      out.add(u.toString());
      if (out.size >= max) break;
      continue;
    }
    // A listing page: sits under a listings-like section and ends in a slug or a number.
    const looksListing = /\/(?:listings?|businesses?-for-sale|business-for-sale|business-opportunity|buy-a-(?:website|business)|for-sale|opportunit(?:y|ies)|startups?)\/[^/]+/.test(path) && /(?:\d{3,}|[a-z0-9]+(?:-[a-z0-9]+){2,})\/?$/.test(path);
    if (!looksListing || /\/(?:page|category|tag|search|industry|state|location)\//.test(path)) continue;
    u.search = "";
    out.add(u.toString());
    if (out.size >= max) break;
  }
  return [...out];
}

/** A search page the Worker can fetch: collect its listing links and import the ones we haven't seen. */
async function runUrlSearch(env: Env, s: SavedSearch): Promise<{ count: number; created: number; cursor: string | null }> {
  const res = await fetch(s.query, { headers: { Accept: "text/html", "User-Agent": UA } });
  if (!res.ok) throw new Error(`${new URL(s.query).hostname} answered ${res.status}${res.status === 403 ? ": this site blocks servers; make it a browser search" : ""}`);
  const links = listingLinks(res.url || s.query, (await res.text()).slice(0, 3_000_000));
  const fresh = await unseen(env, links);
  const inputs: ListingInput[] = [];
  // A few detail pages per run keeps each cron tick short; the rest are picked up on later runs.
  for (const url of fresh.slice(0, 8)) {
    try {
      inputs.push(parseListingPage(await fetchPage(url)));
    } catch {
      // One bad page shouldn't sink the run.
    }
  }
  const r = inputs.length ? await upsertListings(env, inputs, sourceFromUrl(s.query)) : { created: 0 };
  return { count: links.length, created: r.created, cursor: null };
}

/** Of these listing URLs, the ones not in the database yet. */
export async function unseen(env: Env, urls: string[]): Promise<string[]> {
  if (!urls.length) return [];
  const d = await db(env);
  const known = new Set<string>();
  for (let i = 0; i < urls.length; i += 80) {
    const chunk = urls.slice(i, i + 80);
    const { results } = await d.prepare(`SELECT url FROM listings WHERE url IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ url: string }>();
    for (const r of results) known.add(r.url);
  }
  return urls.filter((u) => !known.has(u));
}

// ---------- saved searches ----------

export async function listSearches(env: Env): Promise<SavedSearch[]> {
  const { results } = await (await db(env)).prepare("SELECT * FROM searches ORDER BY id").all<SavedSearch>();
  return results;
}

export async function saveSearch(env: Env, id: number | null, s: Partial<SavedSearch>): Promise<number> {
  const d = await db(env);
  const source = String(s.source ?? "");
  if (!(SOURCE_KINDS as readonly string[]).includes(source)) throw new HttpError(400, `source must be one of: ${SOURCE_KINDS.join(", ")}`);
  const name = (s.name ?? "").trim().slice(0, 120);
  const query = (s.query ?? "").trim();
  if (!name) throw new HttpError(400, "give the search a name");
  if (source === "url" || source === "browser") {
    if (!/^https?:\/\/\S+$/i.test(query)) throw new HttpError(400, "paste the full URL of the search-results page");
  } else if (query && typeof parseJson<unknown>(query, null) !== "object") {
    throw new HttpError(400, "filters must be a JSON object, e.g. {\"listing_price_to\": 1000000}");
  }
  const every = Math.max(1, Math.min(168, Math.round(Number(s.everyHours) || 12)));
  const enabled = s.enabled === 0 ? 0 : 1;
  if (id) {
    await d.prepare("UPDATE searches SET source = ?, name = ?, query = ?, everyHours = ?, enabled = ?, cursor = NULL WHERE id = ?").bind(source, name, query, every, enabled, id).run();
    return id;
  }
  const r = await d.prepare("INSERT INTO searches (source, name, query, everyHours, enabled) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(source, name, query, every, enabled).first<{ id: number }>();
  return r!.id;
}

export async function deleteSearch(env: Env, id: number): Promise<void> {
  await (await db(env)).prepare("DELETE FROM searches WHERE id = ?").bind(id).run();
}

async function finishSearch(env: Env, id: number, r: { count: number; created: number; cursor: string | null } | null, error: string | null): Promise<void> {
  await (await db(env))
    .prepare("UPDATE searches SET lastRun = ?, lastCount = COALESCE(?, lastCount), lastNew = COALESCE(?, lastNew), lastError = ?, cursor = ?, leaseUntil = 0 WHERE id = ?")
    .bind(Date.now(), r?.count ?? null, r?.created ?? null, error, r?.cursor ?? null, id)
    .run();
}

/** Run one saved search that the Worker handles itself (not a browser search). */
export async function runSearch(env: Env, id: number): Promise<{ count: number; created: number }> {
  const s = await (await db(env)).prepare("SELECT * FROM searches WHERE id = ?").bind(id).first<SavedSearch>();
  if (!s) throw new HttpError(404, "search not found");
  if (s.source === "browser") throw new HttpError(409, "browser searches are run by the runner: start it and it will pick this up");
  try {
    const r = s.source === "empireflippers" ? await runEmpireFlippers(env, s) : s.source === "flippa" ? await runFlippa(env, s) : await runUrlSearch(env, s);
    await finishSearch(env, id, r, null);
    if (r.created) await logEvent(env, { actor: s.source, type: "sourcing", message: `${s.name}: ${r.created} new listing${r.created === 1 ? "" : "s"}` });
    return r;
  } catch (e) {
    await finishSearch(env, id, null, (e as Error).message.slice(0, 300));
    throw e;
  }
}

/** Cron: run server-side searches that are due. A search mid-pagination (cursor set) continues right away. */
export async function runDueSearches(env: Env, max = 2): Promise<string[]> {
  const now = Date.now();
  const { results } = await (await db(env))
    .prepare("SELECT * FROM searches WHERE enabled = 1 AND source != 'browser' AND (cursor IS NOT NULL OR lastRun IS NULL OR lastRun + everyHours * ?1 < ?2) ORDER BY (cursor IS NOT NULL) DESC, COALESCE(lastRun, 0) ASC LIMIT ?3")
    .bind(HOUR, now, max)
    .all<SavedSearch>();
  const done: string[] = [];
  for (const s of results) {
    try {
      const r = await runSearch(env, s.id);
      done.push(`${s.name}: ${r.count} seen, ${r.created} new`);
    } catch (e) {
      done.push(`${s.name}: ${(e as Error).message}`);
    }
  }
  return done;
}

// ---------- browser runner ----------

export interface SourceTask {
  kind: "source";
  searchId: number;
  name: string;
  url: string;
}

/** Hand the runner one browser search that is due, leased for 20 minutes. */
export async function claimBrowserSearch(env: Env): Promise<SourceTask | null> {
  const d = await db(env);
  const now = Date.now();
  const { results } = await d
    .prepare("SELECT * FROM searches WHERE enabled = 1 AND source = 'browser' AND leaseUntil < ?1 AND (lastRun IS NULL OR lastRun + everyHours * ?2 < ?1) ORDER BY COALESCE(lastRun, 0) ASC LIMIT 3")
    .bind(now, HOUR)
    .all<SavedSearch>();
  for (const s of results) {
    const won = await d.prepare("UPDATE searches SET leaseUntil = ? WHERE id = ? AND leaseUntil < ?").bind(now + 20 * 60_000, s.id, now).run();
    if (won.meta.changes === 1) return { kind: "source", searchId: s.id, name: s.name, url: s.query };
  }
  return null;
}

/** Pages the runner read for a browser search: parse and store them, then close out the search run. */
export async function ingestPages(env: Env, a: { searchId?: number | null; pages: PagePayload[]; seen?: number; error?: string | null; done?: boolean }, actor: string): Promise<{ created: number; updated: number }> {
  const inputs: ListingInput[] = [];
  for (const p of (a.pages ?? []).slice(0, 60)) {
    if (!p?.url || !p.text) continue;
    const parsed = parseListingPage(p);
    if (parsed.title !== "Untitled listing") inputs.push(parsed);
  }
  const r = inputs.length ? await upsertListings(env, inputs, actor) : { created: 0, updated: 0 };
  if (a.searchId && (a.done || a.error)) {
    const s = await (await db(env)).prepare("SELECT name FROM searches WHERE id = ?").bind(a.searchId).first<{ name: string }>();
    await finishSearch(env, a.searchId, a.error ? null : { count: a.seen ?? inputs.length, created: r.created, cursor: null }, a.error ?? null);
    if (r.created && s) await logEvent(env, { actor, type: "sourcing", message: `${s.name}: ${r.created} new listing${r.created === 1 ? "" : "s"}` });
  }
  return { created: r.created, updated: r.updated };
}

// ---------- alert emails ----------

export const isAlertSender = (from: string) => {
  const domain = (from.match(/@([\w.-]+)/)?.[1] ?? "").toLowerCase();
  return ALERT_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
};

export async function ingestAlert(env: Env, mail: AlertEmail): Promise<{ created: number; found: number }> {
  const inputs = parseAlertEmail(mail);
  if (!inputs.length) return { created: 0, found: 0 };
  const r = await upsertListings(env, inputs, "alerts");
  if (r.created) await logEvent(env, { actor: "alerts", type: "sourcing", message: `${inputs[0].source} alert "${mail.subject.slice(0, 80)}": ${r.created} new listing${r.created === 1 ? "" : "s"}` });
  return { created: r.created, found: inputs.length };
}
