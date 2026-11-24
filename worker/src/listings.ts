import { db, getSetting, logEvent, parseJson } from "./db";
import { extractSignals, hash, parseState, sourceFromUrl, sourceIdFromUrl } from "./parse";
import { DEFAULT_BUY_BOX, computeFit, daysOnline, multipleOf } from "./score";
import { DAY, HttpError, STAGES } from "./types";
import type { BuyBox, Contact, DocumentRow, Env, EventRow, Facets, Listing, ListingDetail, ListingInput, Message, Note, Stage } from "./types";

/** Fields that describe the business itself: importers may set them, and a hand edit locks them. */
const DATA_FIELDS = [
  "url", "title", "description", "industry", "model", "location", "state", "country",
  "askingPrice", "revenue", "cashFlow", "ebitda", "inventory", "ffe", "realEstate", "established", "employees", "listedAt",
  "sellerFinancing", "financingNotes", "sbaEligible", "reasonForSelling", "ownerRole", "ownerHours", "ownerStays", "transitionNotes",
  "remoteManageable", "homeBased", "franchise", "status",
] as const;
type DataField = (typeof DATA_FIELDS)[number];

const NUMERIC = new Set<string>(["askingPrice", "revenue", "cashFlow", "ebitda", "inventory", "ffe", "established", "employees", "listedAt", "ownerHours", "homeBased", "franchise", "synergyOverride", "starred", "cimReceived", "contactId", "dupOf"]);
const ENUMS: Record<string, readonly string[]> = {
  sellerFinancing: ["yes", "no", "unknown"],
  sbaEligible: ["yes", "no", "unknown"],
  ownerRole: ["absentee", "semi", "operator", "unknown"],
  ownerStays: ["yes", "transition", "no", "unknown"],
  remoteManageable: ["yes", "partial", "no", "unknown"],
  status: ["active", "pending", "sold", "removed"],
  stage: STAGES,
  contactChannel: ["email", "form", "phone", "unknown"],
  ndaStatus: ["none", "requested", "signed"],
};
/** Marketplaces that only list online businesses: remote-manageable unless the listing says otherwise. */
const ONLINE_SOURCES = new Set(["flippa", "empireflippers", "acquire", "motioninvest", "quietlight", "websiteclosers", "feinternational", "latonas"]);

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === "unknown";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "manual";

type Row = Record<string, unknown>;

export function hydrate(row: Row, now = Date.now()): Listing {
  const l = { ...row } as unknown as Listing;
  l.tags = parseJson<string[]>(row.tags, []);
  l.locked = parseJson<string[]>(row.locked, []);
  l.fitBreakdown = parseJson(row.fitBreakdown, []);
  l.daysOnline = daysOnline(l, now);
  l.multiple = multipleOf(l);
  return l;
}

export async function buyBox(env: Env): Promise<BuyBox> {
  return { ...DEFAULT_BUY_BOX, ...((await getSetting<Partial<BuyBox>>(env, "buybox")) ?? {}) };
}

function coerce(field: string, v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null || v === "") return ENUMS[field] ? "unknown" : null;
  if (NUMERIC.has(field)) {
    const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  if (ENUMS[field]) {
    const s = String(v).toLowerCase();
    if (!ENUMS[field].includes(s)) throw new HttpError(400, `${field} must be one of: ${ENUMS[field].join(", ")}`);
    return s;
  }
  return String(v).trim().slice(0, field === "description" ? 6000 : field === "url" ? 1000 : 600);
}

interface Normalised {
  source: string;
  sourceId: string;
  data: Partial<Record<DataField, unknown>>;
  tags: string[];
  contact: { name: string | null; email: string | null; phone: string | null; company: string | null; role: Contact["role"] } | null;
  rawText: string | null;
}

/** Clean one input: derive source and id, fill gaps from the text signals, coerce every field. */
export function normalise(input: ListingInput): Normalised {
  const title = (input.title ?? "").replace(/\s+/g, " ").trim();
  if (!title) throw new HttpError(400, "a listing needs a title");
  const url = input.url?.trim() || null;
  const source = slug(input.source || sourceFromUrl(url));
  const sourceId = (input.sourceId ? String(input.sourceId) : sourceIdFromUrl(url)) ?? `t-${hash(`${title.toLowerCase()}|${input.askingPrice ?? ""}`)}`;

  const sig = extractSignals(`${input.description ?? ""}\n${input.rawText ?? ""}`);
  const filled: ListingInput = { ...input, title, url };
  if (isEmpty(filled.sellerFinancing)) filled.sellerFinancing = sig.sellerFinancing;
  if (isEmpty(filled.financingNotes)) filled.financingNotes = sig.financingNotes;
  if (isEmpty(filled.sbaEligible)) filled.sbaEligible = sig.sbaEligible;
  if (isEmpty(filled.reasonForSelling)) filled.reasonForSelling = sig.reasonForSelling;
  if (isEmpty(filled.ownerRole)) filled.ownerRole = sig.ownerRole;
  if (isEmpty(filled.ownerHours)) filled.ownerHours = sig.ownerHours;
  if (isEmpty(filled.ownerStays)) filled.ownerStays = sig.ownerStays;
  if (isEmpty(filled.transitionNotes)) filled.transitionNotes = sig.transitionNotes;
  if (isEmpty(filled.remoteManageable)) filled.remoteManageable = sig.remoteManageable !== "unknown" ? sig.remoteManageable : ONLINE_SOURCES.has(source) ? "yes" : "unknown";
  if (isEmpty(filled.homeBased)) filled.homeBased = sig.homeBased;
  if (isEmpty(filled.franchise)) filled.franchise = sig.franchise;
  if (isEmpty(filled.state)) filled.state = parseState(filled.location);

  const data: Partial<Record<DataField, unknown>> = {};
  for (const f of DATA_FIELDS) {
    const v = coerce(f, (filled as unknown as Row)[f]);
    if (v !== undefined) data[f] = v;
  }
  const email = input.contactEmail?.trim().toLowerCase() || null;
  const hasContact = !!(email || input.contactName?.trim() || input.contactPhone?.trim());
  return {
    source,
    sourceId: sourceId.slice(0, 160),
    data,
    tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12),
    contact: hasContact
      ? { name: input.contactName?.trim().slice(0, 120) || null, email: email && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) ? email : null, phone: input.contactPhone?.trim().slice(0, 40) || null, company: input.contactCompany?.trim().slice(0, 120) || null, role: input.contactRole ?? "broker" }
      : null,
    rawText: input.rawText?.trim() || null,
  };
}

// ---------- contacts ----------

export async function upsertContact(env: Env, c: { name?: string | null; email?: string | null; phone?: string | null; company?: string | null; role?: Contact["role"] }): Promise<number> {
  const d = await db(env);
  const email = c.email?.trim().toLowerCase() || null;
  let existing: { id: number } | null = null;
  if (email) existing = await d.prepare("SELECT id FROM contacts WHERE email = ?").bind(email).first<{ id: number }>();
  if (!existing && c.name) {
    existing = await d
      .prepare("SELECT id FROM contacts WHERE lower(name) = lower(?1) AND (email IS NULL OR ?2 IS NULL) AND (?3 IS NULL OR company IS NULL OR lower(company) = lower(?3)) LIMIT 1")
      .bind(c.name, email, c.company ?? null)
      .first<{ id: number }>();
  }
  if (existing) {
    // Fill gaps only; never overwrite what's already known about a person.
    await d
      .prepare("UPDATE contacts SET name = COALESCE(name, ?1), email = COALESCE(email, ?2), phone = COALESCE(phone, ?3), company = COALESCE(company, ?4) WHERE id = ?5")
      .bind(c.name ?? null, email, c.phone ?? null, c.company ?? null, existing.id)
      .run();
    return existing.id;
  }
  const r = await d
    .prepare("INSERT INTO contacts (name, email, phone, company, role, createdAt) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(c.name ?? null, email, c.phone ?? null, c.company ?? null, c.role ?? "broker", Date.now())
    .first<{ id: number }>();
  return r!.id;
}

export async function listContacts(env: Env): Promise<Contact[]> {
  const { results } = await (await db(env))
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM listings l WHERE l.contactId = c.id) AS listings,
              (SELECT MAX(sentAt) FROM messages m WHERE m.contactId = c.id AND m.direction = 'out') AS lastContactAt
         FROM contacts c ORDER BY listings DESC, c.createdAt DESC LIMIT 500`,
    )
    .all<Contact>();
  return results;
}

export async function patchContact(env: Env, id: number, body: Partial<Contact>): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of ["name", "email", "phone", "company", "role", "notes"] as const) {
    if (body[f] === undefined) continue;
    sets.push(`${f} = ?`);
    vals.push(body[f] === "" ? null : f === "email" && body.email ? body.email.trim().toLowerCase() : body[f]);
  }
  if (body.doNotContact !== undefined) {
    sets.push("doNotContact = ?");
    vals.push(body.doNotContact ? 1 : 0);
  }
  if (!sets.length) return;
  await (await db(env)).prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
}

// ---------- upsert ----------

export interface UpsertResult {
  id: number;
  created: boolean;
  changed: string[];
  title: string;
}

const INSERT_COLS = ["source", "sourceId", ...DATA_FIELDS, "firstSeen", "lastSeen", "synergy", "fitScore", "fitBreakdown", "stage", "stageAt", "contactId", "contactChannel", "dupOf", "tags", "createdAt", "updatedAt"];

/**
 * Insert or refresh listings. Built for bulk: one read per source, then the writes in batches, so a
 * page of a hundred listings is a handful of D1 calls. An existing listing only gains information:
 * a hand-edited (locked) field is never touched, and a known value is never replaced by an unknown one.
 */
export async function upsertListings(env: Env, inputs: ListingInput[], actor: string): Promise<{ results: UpsertResult[]; created: number; updated: number }> {
  const d = await db(env);
  const now = Date.now();
  const box = await buyBox(env);

  const byKey = new Map<string, Normalised>();
  for (const input of inputs) {
    const n = normalise(input);
    byKey.set(`${n.source}\u0000${n.sourceId}`, n);
  }
  const items = [...byKey.values()];
  if (!items.length) return { results: [], created: 0, updated: 0 };

  // Existing rows, one query per source per 80 ids.
  const existing = new Map<string, Row>();
  const bySource = new Map<string, string[]>();
  for (const n of items) bySource.set(n.source, [...(bySource.get(n.source) ?? []), n.sourceId]);
  for (const [source, ids] of bySource) {
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      const { results } = await d.prepare(`SELECT * FROM listings WHERE source = ? AND sourceId IN (${chunk.map(() => "?").join(",")})`).bind(source, ...chunk).all<Row>();
      for (const r of results) existing.set(`${r.source}\u0000${r.sourceId}`, r);
    }
  }

  // Likely duplicates across marketplaces: the same asking price and cash flow under another source.
  const fresh = items.filter((n) => !existing.has(`${n.source}\u0000${n.sourceId}`));
  const dupCandidates = new Map<string, { id: number; source: string }[]>();
  const prices = [...new Set(fresh.filter((n) => n.data.askingPrice && n.data.cashFlow).map((n) => n.data.askingPrice as number))];
  for (let i = 0; i < prices.length; i += 80) {
    const chunk = prices.slice(i, i + 80);
    const { results } = await d
      .prepare(`SELECT id, source, askingPrice, cashFlow FROM listings WHERE dupOf IS NULL AND askingPrice IN (${chunk.map(() => "?").join(",")}) ORDER BY id`)
      .bind(...chunk)
      .all<{ id: number; source: string; askingPrice: number; cashFlow: number | null }>();
    for (const r of results) {
      const k = `${r.askingPrice}|${r.cashFlow}`;
      dupCandidates.set(k, [...(dupCandidates.get(k) ?? []), { id: r.id, source: r.source }]);
    }
  }

  const stmts: D1PreparedStatement[] = [];
  const meta: { n: Normalised; created: boolean; id?: number; changed: string[]; priceFrom?: number | null }[] = [];

  for (const n of items) {
    const row = existing.get(`${n.source}\u0000${n.sourceId}`);
    const contactId = n.contact ? await upsertContact(env, n.contact) : null;
    if (row) {
      const locked = new Set(parseJson<string[]>(row.locked, []));
      const sets: Row = {};
      for (const f of DATA_FIELDS) {
        const v = n.data[f];
        if (locked.has(f) || isEmpty(v) || v === row[f]) continue;
        if (f === "status" && v === "active" && row.status !== "removed") continue; // importers default to active; only un-remove
        if (f === "listedAt" && row.listedAt) continue; // the first date we learned stands
        sets[f] = v;
      }
      if (row.status === "removed" && !("status" in sets) && !locked.has("status")) sets.status = "active";
      const tags = [...new Set([...parseJson<string[]>(row.tags, []), ...n.tags])];
      if (tags.length !== parseJson<string[]>(row.tags, []).length) sets.tags = JSON.stringify(tags);
      if (contactId && !row.contactId) {
        sets.contactId = contactId;
        if (row.contactChannel === "unknown" || row.contactChannel === "form") sets.contactChannel = n.contact?.email ? "email" : row.contactChannel;
      }
      const merged = { ...row, ...sets } as Row;
      const fit = computeFit(hydrate(merged, now), box, now);
      const changed = Object.keys(sets);
      const all: Row = { ...sets, lastSeen: now, synergy: fit.synergy, fitScore: fit.fitScore, fitBreakdown: JSON.stringify(fit.fitBreakdown) };
      if (changed.length) all.updatedAt = now;
      const cols = Object.keys(all);
      stmts.push(d.prepare(`UPDATE listings SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).bind(...cols.map((c) => all[c] ?? null), row.id));
      meta.push({ n, created: false, id: row.id as number, changed, priceFrom: "askingPrice" in sets ? (row.askingPrice as number | null) : undefined });
    } else {
      const data: Row = { sellerFinancing: "unknown", sbaEligible: "unknown", ownerRole: "unknown", ownerStays: "unknown", remoteManageable: "unknown", status: "active", ...n.data };
      const dup = data.askingPrice && data.cashFlow ? (dupCandidates.get(`${data.askingPrice}|${data.cashFlow}`) ?? []).find((c) => c.source !== n.source) : undefined;
      const base: Row = {
        ...data, source: n.source, sourceId: n.sourceId, firstSeen: now, lastSeen: now, stage: "new", stageAt: now, synergyOverride: null,
        contactId, contactChannel: n.contact?.email ? "email" : n.contact?.phone && !data.url ? "phone" : data.url ? "form" : "unknown",
        dupOf: dup?.id ?? null, tags: JSON.stringify(n.tags), createdAt: now, updatedAt: now,
      };
      const fit = computeFit(hydrate({ ...base, locked: "[]", fitBreakdown: "[]" }, now), box, now);
      const full: Row = { ...base, synergy: fit.synergy, fitScore: fit.fitScore, fitBreakdown: JSON.stringify(fit.fitBreakdown) };
      stmts.push(d.prepare(`INSERT INTO listings (${INSERT_COLS.join(", ")}) VALUES (${INSERT_COLS.map(() => "?").join(", ")}) RETURNING id`).bind(...INSERT_COLS.map((c) => full[c] ?? null)));
      meta.push({ n, created: true, changed: [] });
    }
  }

  for (let i = 0; i < stmts.length; i += 40) {
    const res = await d.batch<{ id: number }>(stmts.slice(i, i + 40));
    res.forEach((r, j) => {
      const m = meta[i + j];
      if (m.created) m.id = r.results[0]?.id;
    });
  }

  // Follow-on rows: the timeline entry, price history, and a text snapshot in R2.
  const after: D1PreparedStatement[] = [];
  for (const m of meta) {
    if (!m.id) continue;
    const price = (m.n.data.askingPrice as number | null | undefined) ?? null;
    if (m.created) {
      after.push(d.prepare("INSERT INTO events (at, actor, listingId, type, message) VALUES (?, ?, ?, 'sourced', ?)").bind(now, actor, m.id, `Found on ${m.n.source}`));
      after.push(d.prepare("INSERT INTO price_history (listingId, at, askingPrice) VALUES (?, ?, ?)").bind(m.id, now, price));
    } else if (m.priceFrom !== undefined) {
      after.push(d.prepare("INSERT INTO price_history (listingId, at, askingPrice) VALUES (?, ?, ?)").bind(m.id, now, price));
      const dir = m.priceFrom && price ? (price < m.priceFrom ? "dropped" : "raised") : "changed";
      after.push(d.prepare("INSERT INTO events (at, actor, listingId, type, message) VALUES (?, ?, ?, 'price', ?)").bind(now, actor, m.id, `Asking price ${dir}: ${money(m.priceFrom)} → ${money(price)}`));
    }
    if (m.n.rawText && (m.created || m.priceFrom !== undefined)) {
      const key = `snapshots/${m.id}/${now}.txt`;
      await env.FILES.put(key, m.n.rawText, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
      after.push(
        d.prepare("INSERT INTO documents (listingId, key, filename, contentType, size, kind, uploadedAt) VALUES (?, ?, ?, 'text/plain; charset=utf-8', ?, 'snapshot', ?)").bind(m.id, key, `listing-page-${new Date(now).toISOString().slice(0, 10)}.txt`, m.n.rawText.length, now),
      );
    }
  }
  for (let i = 0; i < after.length; i += 40) await d.batch(after.slice(i, i + 40));

  const results = meta.filter((m) => m.id).map((m) => ({ id: m.id!, created: m.created, changed: m.changed, title: String(m.n.data.title) }));
  return { results, created: results.filter((r) => r.created).length, updated: results.filter((r) => !r.created && r.changed.length).length };
}

const money = (n: number | null | undefined) => (n == null ? "not stated" : `$${n.toLocaleString("en-US")}`);

// ---------- read ----------

export interface ListFilters {
  q?: string;
  stage?: string;
  status?: string;
  source?: string;
  industry?: string;
  sellerFinancing?: string;
  remote?: string;
  ownerStays?: string;
  contacted?: string;
  minFit?: number;
  maxPrice?: number;
  minCashFlow?: number;
  starred?: boolean;
  hideDups?: boolean;
  sort?: string;
  dir?: string;
  limit?: number;
  offset?: number;
}

const SORTS: Record<string, string> = {
  fit: "l.fitScore",
  price: "l.askingPrice",
  cashFlow: "l.cashFlow",
  revenue: "l.revenue",
  multiple: "CASE WHEN l.cashFlow > 0 THEN l.askingPrice * 1.0 / l.cashFlow END",
  // More days online = an older listing date, so the direction is flipped below.
  daysOnline: "COALESCE(l.listedAt, l.firstSeen)",
  added: "l.firstSeen",
  contacted: "l.lastContactAt",
  title: "l.title COLLATE NOCASE",
  synergy: "COALESCE(l.synergyOverride, l.synergy)",
  stage: "l.stageAt",
};

export async function listListings(env: Env, f: ListFilters): Promise<{ items: Listing[]; total: number; facets: Facets }> {
  const d = await db(env);
  const where: string[] = [];
  const args: unknown[] = [];
  const inList = (col: string, csv: string) => {
    const vals = csv.split(",").map((s) => s.trim()).filter(Boolean);
    if (!vals.length) return;
    where.push(`${col} IN (${vals.map(() => "?").join(",")})`);
    args.push(...vals);
  };
  if (f.stage) inList("l.stage", f.stage);
  if (f.status) inList("l.status", f.status);
  if (f.source) inList("l.source", f.source);
  if (f.industry) inList("l.industry", f.industry);
  if (f.sellerFinancing) inList("l.sellerFinancing", f.sellerFinancing);
  if (f.remote) inList("l.remoteManageable", f.remote);
  if (f.ownerStays) inList("l.ownerStays", f.ownerStays);
  if (f.contacted === "yes") where.push("l.contactedAt IS NOT NULL");
  if (f.contacted === "no") where.push("l.contactedAt IS NULL");
  if (f.contacted === "replied") where.push("l.repliedAt IS NOT NULL");
  if (f.minFit) (where.push("l.fitScore >= ?"), args.push(f.minFit));
  if (f.maxPrice) (where.push("l.askingPrice <= ?"), args.push(f.maxPrice));
  if (f.minCashFlow) (where.push("l.cashFlow >= ?"), args.push(f.minCashFlow));
  if (f.starred) where.push("l.starred = 1");
  if (f.hideDups) where.push("l.dupOf IS NULL");
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_]/g, "")}%`;
    where.push("(l.title LIKE ?1 OR l.description LIKE ?1 OR l.industry LIKE ?1 OR l.location LIKE ?1 OR l.sourceId LIKE ?1 OR l.reasonForSelling LIKE ?1)".replace(/\?1/g, "?"));
    args.push(like, like, like, like, like, like);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sortKey = f.sort && SORTS[f.sort] ? f.sort : "fit";
  let desc = (f.dir ?? "desc").toLowerCase() !== "asc";
  if (sortKey === "daysOnline") desc = !desc;
  const order = `${SORTS[sortKey]} ${desc ? "DESC" : "ASC"} NULLS LAST, l.id DESC`;
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);

  const [rows, count, sources, industries, stages] = await d.batch<Row>([
    d
      .prepare(`SELECT l.*, substr(l.description, 1, 400) AS description, c.name AS contactName, c.email AS contactEmail FROM listings l LEFT JOIN contacts c ON c.id = l.contactId ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...args, limit, offset),
    d.prepare(`SELECT COUNT(*) AS n FROM listings l ${w}`).bind(...args),
    d.prepare("SELECT source AS value, COUNT(*) AS n FROM listings GROUP BY source ORDER BY n DESC"),
    d.prepare("SELECT industry AS value, COUNT(*) AS n FROM listings WHERE industry IS NOT NULL GROUP BY industry ORDER BY n DESC LIMIT 60"),
    d.prepare("SELECT stage AS value, COUNT(*) AS n FROM listings GROUP BY stage"),
  ]);
  const now = Date.now();
  return {
    items: rows.results.map((r) => hydrate(r, now)),
    total: Number(count.results[0]?.n ?? 0),
    facets: {
      sources: sources.results as unknown as Facets["sources"],
      industries: industries.results as unknown as Facets["industries"],
      stages: Object.fromEntries(stages.results.map((r) => [String(r.value), Number(r.n)])),
    },
  };
}

export async function getListing(env: Env, id: number): Promise<Listing> {
  const row = await (await db(env))
    .prepare("SELECT l.*, c.name AS contactName, c.email AS contactEmail FROM listings l LEFT JOIN contacts c ON c.id = l.contactId WHERE l.id = ?")
    .bind(id)
    .first<Row>();
  if (!row) throw new HttpError(404, "listing not found");
  return hydrate(row);
}

export async function getDetail(env: Env, id: number): Promise<ListingDetail> {
  const d = await db(env);
  const listing = await getListing(env, id);
  const [contact, notes, events, messages, documents, prices, dup] = await d.batch<Row>([
    d.prepare("SELECT * FROM contacts WHERE id = ?").bind(listing.contactId ?? -1),
    d.prepare("SELECT * FROM notes WHERE listingId = ? ORDER BY at DESC LIMIT 100").bind(id),
    d.prepare("SELECT * FROM events WHERE listingId = ? ORDER BY at DESC, id DESC LIMIT 80").bind(id),
    d.prepare("SELECT m.*, s.name AS sequenceName FROM messages m LEFT JOIN enrollments e ON e.id = m.enrollmentId LEFT JOIN sequences s ON s.id = e.sequenceId WHERE m.listingId = ? ORDER BY COALESCE(m.sentAt, m.scheduledAt, m.createdAt) DESC LIMIT 60").bind(id),
    d.prepare("SELECT id, listingId, filename, contentType, size, kind, uploadedAt FROM documents WHERE listingId = ? ORDER BY uploadedAt DESC").bind(id),
    d.prepare("SELECT at, askingPrice FROM price_history WHERE listingId = ? ORDER BY at ASC").bind(id),
    d.prepare("SELECT id, title, source FROM listings WHERE id = ?").bind(listing.dupOf ?? -1),
  ]);
  return {
    listing,
    contact: (contact.results[0] as unknown as Contact) ?? null,
    notes: notes.results as unknown as Note[],
    events: events.results as unknown as EventRow[],
    messages: messages.results as unknown as Message[],
    documents: documents.results as unknown as DocumentRow[],
    priceHistory: prices.results as unknown as ListingDetail["priceHistory"],
    duplicate: (dup.results[0] as unknown as ListingDetail["duplicate"]) ?? null,
  };
}

// ---------- edit ----------

const PATCHABLE = new Set<string>([...DATA_FIELDS, "synergyOverride", "synergyNotes", "stage", "starred", "contactId", "contactChannel", "ndaStatus", "cimReceived", "dupOf"]);

export async function patchListing(env: Env, id: number, patch: Row, actor: string): Promise<Listing> {
  const d = await db(env);
  const row = await d.prepare("SELECT * FROM listings WHERE id = ?").bind(id).first<Row>();
  if (!row) throw new HttpError(404, "listing not found");
  const now = Date.now();
  const sets: Row = {};
  const locked = new Set(parseJson<string[]>(row.locked, []));
  for (const [k, raw] of Object.entries(patch)) {
    if (k === "tags") {
      if (!Array.isArray(raw)) throw new HttpError(400, "tags must be an array");
      sets.tags = JSON.stringify(raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20));
      continue;
    }
    if (k === "unlock") {
      for (const f of ([] as unknown[]).concat(raw)) locked.delete(String(f));
      continue;
    }
    if (!PATCHABLE.has(k)) continue;
    const v = coerce(k, raw);
    if (v === undefined || v === row[k]) continue;
    if (k === "title" && !v) throw new HttpError(400, "title can't be empty");
    if (k === "synergyOverride" && v !== null && (Number(v) < 0 || Number(v) > 5)) throw new HttpError(400, "synergy is 0 to 5");
    sets[k] = v;
    if ((DATA_FIELDS as readonly string[]).includes(k)) locked.add(k);
  }
  if ("location" in sets && !("state" in sets) && !locked.has("state")) sets.state = parseState(sets.location as string | null);
  if ("stage" in sets) sets.stageAt = now;
  sets.locked = JSON.stringify([...locked]);
  const merged = { ...row, ...sets };
  const fit = computeFit(hydrate(merged, now), await buyBox(env), now);
  Object.assign(sets, { synergy: fit.synergy, fitScore: fit.fitScore, fitBreakdown: JSON.stringify(fit.fitBreakdown), updatedAt: now });
  const cols = Object.keys(sets);
  await d.prepare(`UPDATE listings SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).bind(...cols.map((c) => sets[c] ?? null), id).run();

  if ("stage" in sets) await logEvent(env, { actor, listingId: id, type: "stage", message: `${row.stage} → ${sets.stage}` });
  if ("askingPrice" in sets) await d.prepare("INSERT INTO price_history (listingId, at, askingPrice) VALUES (?, ?, ?)").bind(id, now, sets.askingPrice ?? null).run();
  return getListing(env, id);
}

export async function addNote(env: Env, id: number, author: string, body: string): Promise<void> {
  const text = body.trim().slice(0, 4000);
  if (!text) throw new HttpError(400, "note is empty");
  await getListing(env, id);
  await (await db(env)).prepare("INSERT INTO notes (listingId, at, author, body) VALUES (?, ?, ?, ?)").bind(id, Date.now(), author, text).run();
}

/** Record a contact made outside the hub: a marketplace's contact form, a phone call. */
export async function logContact(env: Env, id: number, actor: string, c: { channel?: string; note?: string }): Promise<Listing> {
  const d = await db(env);
  const now = Date.now();
  const l = await getListing(env, id);
  const channel = ["email", "form", "phone"].includes(c.channel ?? "") ? c.channel! : "form";
  const stage: Stage = l.stage === "new" || l.stage === "shortlist" ? "contacted" : l.stage;
  await d
    .prepare("UPDATE listings SET contactedAt = COALESCE(contactedAt, ?1), lastContactAt = ?1, contactCount = contactCount + 1, contactChannel = ?2, stage = ?3, stageAt = CASE WHEN stage = ?3 THEN stageAt ELSE ?1 END, updatedAt = ?1 WHERE id = ?4")
    .bind(now, channel, stage, id)
    .run();
  await logEvent(env, { actor, listingId: id, type: "contacted", message: `Contacted by ${channel}${c.note ? `: ${c.note}` : ""}` });
  return getListing(env, id);
}

export async function deleteListing(env: Env, id: number): Promise<void> {
  const d = await db(env);
  const { results: docs } = await d.prepare("SELECT key FROM documents WHERE listingId = ?").bind(id).all<{ key: string }>();
  if (docs.length) await env.FILES.delete(docs.map((x) => x.key));
  await d.batch([
    d.prepare("DELETE FROM documents WHERE listingId = ?").bind(id),
    d.prepare("DELETE FROM notes WHERE listingId = ?").bind(id),
    d.prepare("DELETE FROM events WHERE listingId = ?").bind(id),
    d.prepare("DELETE FROM price_history WHERE listingId = ?").bind(id),
    d.prepare("UPDATE messages SET status = 'skipped' WHERE listingId = ? AND status IN ('draft', 'approved')").bind(id),
    d.prepare("UPDATE enrollments SET status = 'stopped' WHERE listingId = ? AND status = 'active'").bind(id),
    d.prepare("DELETE FROM listings WHERE id = ?").bind(id),
  ]);
}

/** Recompute every listing's fit and synergy after the buy box changes. */
export async function rescoreAll(env: Env): Promise<number> {
  const d = await db(env);
  const box = await buyBox(env);
  const now = Date.now();
  const { results } = await d.prepare("SELECT * FROM listings ORDER BY id LIMIT 5000").all<Row>();
  const stmts = results.map((r) => {
    const fit = computeFit(hydrate(r, now), box, now);
    return d.prepare("UPDATE listings SET synergy = ?, fitScore = ?, fitBreakdown = ? WHERE id = ?").bind(fit.synergy, fit.fitScore, JSON.stringify(fit.fitBreakdown), r.id);
  });
  for (let i = 0; i < stmts.length; i += 50) await d.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

/**
 * A listing that an API source stopped returning has been sold or pulled. Only applied to sources whose
 * saved search ran cleanly in the last two days, so an importer outage can't empty the pipeline.
 */
export async function expireStale(env: Env): Promise<number> {
  const d = await db(env);
  const now = Date.now();
  const r = await d
    .prepare(
      `UPDATE listings SET status = 'removed', updatedAt = ?1
        WHERE status = 'active' AND lastSeen < ?2 AND locked NOT LIKE '%"status"%'
          AND source IN (SELECT source FROM searches WHERE enabled = 1 AND lastError IS NULL AND lastRun > ?3 AND source IN ('empireflippers', 'flippa'))`,
    )
    .bind(now, now - 10 * DAY, now - 2 * DAY)
    .run();
  return r.meta.changes ?? 0;
}
