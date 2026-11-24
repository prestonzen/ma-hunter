import { buildAnalytics, publicSummary } from "./analytics";
import { adminUser, agentName, agentNames, clearedCookie, isAdminToken, isBridge, isMock, sessionCookie } from "./auth";
import { db, getSetting, recentEvents, setSetting } from "./db";
import { deleteDocument, downloadDocument, uploadDocument } from "./docs";
import { addNote, buyBox, deleteListing, expireStale, getDetail, listContacts, listListings, logContact, patchContact, patchListing, rescoreAll, upsertContact, upsertListings, type ListFilters } from "./listings";
import { handleMcp, nextContactTask, reportContact } from "./mcp";
import { claimDue, deleteTemplate, enroll, handleReply, listMessages, listSequences, listTemplates, markFailed, markSent, outreachSettings, patchMessage, saveSequence, saveTemplate, stopEnrollment, watchList, type InboundEmail } from "./outreach";
import { ALERT_DOMAINS, parseListingPage, type PagePayload } from "./parse";
import { DEFAULT_BUY_BOX } from "./score";
import { seedDemo } from "./seed";
import { claimBrowserSearch, deleteSearch, ingestAlert, ingestPages, isAlertSender, listingLinks, listSearches, previewUrl, runDueSearches, runSearch, saveSearch, unseen } from "./sources";
import { HttpError } from "./types";
import type { BuyBox, Env, ListingInput, OutreachSettings } from "./types";

const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "the request body must be JSON");
  }
}

const int = (s: string | undefined): number => {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "invalid id");
  return n;
};

function filters(q: URLSearchParams): ListFilters {
  const g = (k: string) => q.get(k) ?? undefined;
  const n = (k: string) => (q.get(k) ? Number(q.get(k)) || undefined : undefined);
  return {
    q: g("q"), stage: g("stage"), status: g("status"), source: g("source"), industry: g("industry"), sellerFinancing: g("sellerFinancing"),
    remote: g("remote"), ownerStays: g("ownerStays"), contacted: g("contacted"), minFit: n("minFit"), maxPrice: n("maxPrice"), minCashFlow: n("minCashFlow"),
    starred: q.get("starred") === "1", hideDups: q.get("hideDups") === "1", sort: g("sort"), dir: g("dir"), limit: n("limit"), offset: n("offset"),
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  // Neutralise spreadsheet formulas: listing text comes from the open web.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

async function heartbeat(env: Env, key: string, value: Record<string, unknown>): Promise<void> {
  await setSetting(env, key, { ...value, at: Date.now() });
}

// ---------- route groups ----------

async function adminRoutes(request: Request, env: Env, path: string, user: string): Promise<Response> {
  const url = new URL(request.url);
  const m = request.method;
  const seg = path.split("/").filter(Boolean); // e.g. ["listings", "12", "notes"]

  if (path === "/me") return json({ user, mock: isMock(request, env) });

  if (path === "/status") {
    const d = await db(env);
    const [bridge, queue, settingsRows] = await Promise.all([
      getSetting<{ account?: string; at: number }>(env, "gmail_bridge"),
      d.prepare("SELECT SUM(status = 'draft') AS drafts, SUM(status = 'approved') AS approved, SUM(status = 'needs_human') AS needsHuman, SUM(status = 'failed') AS failed FROM messages WHERE direction = 'out'").first<Record<string, number>>(),
      d.prepare("SELECT key, value FROM settings WHERE key LIKE 'runner:%'").all<{ key: string; value: string }>(),
    ]);
    return json({
      mock: isMock(request, env),
      origin: url.origin,
      gmailBridge: bridge,
      runners: settingsRows.results.map((r) => ({ name: r.key.slice(7), ...(JSON.parse(r.value) as object) })),
      configured: { bridgeToken: (env.GMAIL_BRIDGE_TOKEN ?? "").length >= 24, agents: agentNames(env), flippaToken: !!env.FLIPPA_TOKEN, publicDashboard: env.PUBLIC_DASHBOARD === "true" },
      queue: { drafts: queue?.drafts ?? 0, approved: queue?.approved ?? 0, needsHuman: queue?.needsHuman ?? 0, failed: queue?.failed ?? 0 },
      alertDomains: ALERT_DOMAINS,
    });
  }

  if (path === "/analytics") return json(await buildAnalytics(env));
  if (path === "/events") return json(await recentEvents(env, Number(url.searchParams.get("limit")) || 60));

  // Listings
  if (path === "/listings" && m === "GET") return json(await listListings(env, filters(url.searchParams)));
  if (path === "/listings.csv" && m === "GET") {
    const { items } = await listListings(env, { ...filters(url.searchParams), limit: 500 });
    const cols = ["id", "title", "source", "sourceId", "url", "stage", "status", "fitScore", "industry", "model", "location", "askingPrice", "revenue", "cashFlow", "multiple", "daysOnline", "sellerFinancing", "financingNotes", "reasonForSelling", "ownerRole", "ownerStays", "transitionNotes", "remoteManageable", "synergy", "contactName", "contactEmail", "contactedAt", "repliedAt", "tags"];
    const iso = (v: unknown) => (typeof v === "number" && v > 1e11 ? new Date(v).toISOString().slice(0, 10) : v);
    const lines = [cols.join(","), ...items.map((l) => cols.map((c) => csvCell(c === "contactedAt" || c === "repliedAt" ? iso((l as unknown as Record<string, unknown>)[c]) : c === "synergy" ? (l.synergyOverride ?? l.synergy) : (l as unknown as Record<string, unknown>)[c])).join(","))];
    return new Response(lines.join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ma-hunter-listings-${new Date().toISOString().slice(0, 10)}.csv"` } });
  }
  if (path === "/listings" && m === "POST") {
    const input = await body<ListingInput>(request);
    const r = await upsertListings(env, [{ ...input, source: input.source || (input.url ? undefined : "manual") }], user);
    return json(await getDetail(env, r.results[0].id), 201);
  }
  if (path === "/listings/upsert" && m === "POST") {
    const b = await body<{ listings: ListingInput[] }>(request);
    if (!Array.isArray(b.listings) || !b.listings.length) throw new HttpError(400, "listings must be a non-empty array");
    return json(await upsertListings(env, b.listings.slice(0, 100), user));
  }
  if (path === "/listings/bulk" && m === "POST") {
    const b = await body<{ ids: number[]; patch?: Record<string, unknown>; sequenceId?: number }>(request);
    const ids = (b.ids ?? []).slice(0, 100).map(Number).filter((n) => n > 0);
    const errors: string[] = [];
    let ok = 0;
    for (const id of ids) {
      try {
        if (b.sequenceId) await enroll(env, { sequenceId: b.sequenceId, listingId: id }, user);
        else if (b.patch) await patchListing(env, id, b.patch, user);
        ok++;
      } catch (e) {
        errors.push(`#${id}: ${(e as Error).message}`);
      }
    }
    return json({ ok, errors });
  }
  if (seg[0] === "listings" && seg[1]) {
    const id = int(seg[1]);
    if (!seg[2] && m === "GET") return json(await getDetail(env, id));
    if (!seg[2] && m === "PATCH") {
      await patchListing(env, id, await body<Record<string, unknown>>(request), user);
      return json(await getDetail(env, id));
    }
    if (!seg[2] && m === "DELETE") {
      await deleteListing(env, id);
      return json({ ok: true });
    }
    if (seg[2] === "notes" && m === "POST") {
      await addNote(env, id, user, (await body<{ body: string }>(request)).body ?? "");
      return json(await getDetail(env, id));
    }
    if (seg[2] === "contact-log" && m === "POST") {
      await logContact(env, id, user, await body<{ channel?: string; note?: string }>(request));
      return json(await getDetail(env, id));
    }
    if (seg[2] === "contact" && m === "PUT") {
      // Set or replace the listing's contact from a name / email / phone typed in the detail view.
      const c = await body<{ name?: string; email?: string; phone?: string; company?: string; role?: "broker" | "owner" | "other" }>(request);
      if (!c.email?.trim() && !c.name?.trim() && !c.phone?.trim()) throw new HttpError(400, "give at least a name, an email or a phone number");
      const contactId = await upsertContact(env, c);
      await (await db(env)).prepare("UPDATE listings SET contactId = ?, contactChannel = CASE WHEN ? THEN 'email' ELSE contactChannel END, updatedAt = ? WHERE id = ?").bind(contactId, c.email?.trim() ? 1 : 0, Date.now(), id).run();
      return json(await getDetail(env, id));
    }
    if (seg[2] === "enroll" && m === "POST") {
      const b = await body<{ sequenceId: number }>(request);
      await enroll(env, { sequenceId: Number(b.sequenceId), listingId: id }, user);
      return json(await getDetail(env, id));
    }
    if (seg[2] === "documents" && m === "POST") {
      await uploadDocument(env, id, request, user);
      return json(await getDetail(env, id), 201);
    }
  }
  if (seg[0] === "documents" && seg[1]) {
    if (m === "GET") return downloadDocument(env, int(seg[1]));
    if (m === "DELETE") {
      await deleteDocument(env, int(seg[1]));
      return json({ ok: true });
    }
  }

  // Importing
  if (path === "/import/url" && m === "POST") {
    const { rawText: _raw, ...preview } = await previewUrl((await body<{ url: string }>(request)).url ?? "");
    return json({ listing: preview, textLength: _raw?.length ?? 0 });
  }
  if (path === "/import/url/save" && m === "POST") {
    // Re-fetch so the page text is archived with the listing; the admin's edits win over the parse.
    const b = await body<{ url: string; listing?: ListingInput }>(request);
    const parsed = await previewUrl(b.url ?? "");
    const r = await upsertListings(env, [{ ...parsed, ...(b.listing ?? {}), rawText: parsed.rawText }], user);
    return json(r);
  }
  if (path === "/import/page" && m === "POST") {
    const { rawText: _raw, ...preview } = parseListingPage(await body<PagePayload>(request));
    return json({ listing: preview, textLength: _raw?.length ?? 0 });
  }
  if (path === "/import/cards" && m === "POST") {
    const b = await body<{ cards: { url: string; title?: string; text: string }[] }>(request);
    const listings = (b.cards ?? []).slice(0, 80).map((c) => {
      const { rawText: _raw, ...l } = parseListingPage({ url: c.url, title: c.title ?? c.text.split("\n")[0], text: c.text });
      return l;
    });
    const fresh = new Set(await unseen(env, listings.map((l) => l.url!).filter(Boolean)));
    return json({ listings: listings.map((l) => ({ ...l, isNew: !!l.url && fresh.has(l.url) })) });
  }

  // Settings
  if (path === "/settings" && m === "GET") return json({ buybox: await buyBox(env), outreach: await outreachSettings(env) });
  if (path === "/settings/buybox" && m === "PUT") {
    const b = await body<Partial<BuyBox>>(request);
    const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 40) : []);
    const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
    const box: BuyBox = {
      ...DEFAULT_BUY_BOX,
      priceMin: num(b.priceMin), priceMax: num(b.priceMax), cashFlowMin: num(b.cashFlowMin), multipleMax: num(b.multipleMax),
      industriesInclude: list(b.industriesInclude), industriesExclude: list(b.industriesExclude), keywordsExclude: list(b.keywordsExclude),
      locations: list(b.locations), synergyKeywords: list(b.synergyKeywords),
      requireRemote: !!b.requireRemote, preferSellerFinancing: !!b.preferSellerFinancing, preferOwnerStays: !!b.preferOwnerStays,
      synergyProfile: String(b.synergyProfile ?? "").slice(0, 1000),
    };
    await setSetting(env, "buybox", box);
    return json({ buybox: box, rescored: await rescoreAll(env) });
  }
  if (path === "/settings/outreach" && m === "PUT") {
    const b = await body<Partial<OutreachSettings>>(request);
    const cur = await outreachSettings(env);
    const clamp = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : d);
    const s: OutreachSettings = {
      myName: String(b.myName ?? cur.myName).slice(0, 100), myCompany: String(b.myCompany ?? cur.myCompany).slice(0, 120), myPhone: String(b.myPhone ?? cur.myPhone).slice(0, 40),
      myEmail: String(b.myEmail ?? cur.myEmail).trim().slice(0, 160), buyerIntro: String(b.buyerIntro ?? cur.buyerIntro).slice(0, 800), signature: String(b.signature ?? cur.signature).slice(0, 600),
      dailyCap: clamp(b.dailyCap, 0, 200, cur.dailyCap), formDailyCap: clamp(b.formDailyCap, 0, 60, cur.formDailyCap), perPoll: clamp(b.perPoll, 1, 10, cur.perPoll),
      windowStart: clamp(b.windowStart, 0, 23, cur.windowStart), windowEnd: clamp(b.windowEnd, 1, 24, cur.windowEnd),
      weekdaysOnly: b.weekdaysOnly ?? cur.weekdaysOnly, timezone: String(b.timezone ?? cur.timezone).slice(0, 60), paused: b.paused ?? cur.paused,
    };
    await setSetting(env, "outreach", s);
    return json({ outreach: s });
  }
  if (path === "/rescore" && m === "POST") return json({ rescored: await rescoreAll(env) });

  // Contacts
  if (path === "/contacts" && m === "GET") return json(await listContacts(env));
  if (path === "/contacts" && m === "POST") {
    const c = await body<{ name?: string; email?: string; phone?: string; company?: string; role?: "broker" | "owner" | "other" }>(request);
    if (!c.email?.trim() && !c.name?.trim()) throw new HttpError(400, "a contact needs a name or an email");
    return json({ id: await upsertContact(env, c) }, 201);
  }
  if (seg[0] === "contacts" && seg[1]) {
    const id = int(seg[1]);
    if (!seg[2] && m === "PATCH") {
      await patchContact(env, id, await body(request));
      return json({ ok: true });
    }
    if (seg[2] === "enroll" && m === "POST") {
      const b = await body<{ sequenceId: number }>(request);
      return json(await enroll(env, { sequenceId: Number(b.sequenceId), contactId: id }, user), 201);
    }
  }

  // Outreach
  if (path === "/templates" && m === "GET") return json(await listTemplates(env));
  if (path === "/templates" && m === "POST") return json({ id: await saveTemplate(env, null, await body(request)) }, 201);
  if (seg[0] === "templates" && seg[1]) {
    if (m === "PATCH") return json({ id: await saveTemplate(env, int(seg[1]), await body(request)) });
    if (m === "DELETE") {
      await deleteTemplate(env, int(seg[1]));
      return json({ ok: true });
    }
  }
  if (path === "/sequences" && m === "GET") return json(await listSequences(env));
  if (path === "/sequences" && m === "POST") return json({ id: await saveSequence(env, null, await body(request)) }, 201);
  if (seg[0] === "sequences" && seg[1] && m === "PATCH") return json({ id: await saveSequence(env, int(seg[1]), await body(request)) });
  if (path === "/messages" && m === "GET") return json(await listMessages(env, { status: url.searchParams.get("status") ?? undefined, direction: url.searchParams.get("direction") ?? undefined, limit: Number(url.searchParams.get("limit")) || undefined }));
  if (path === "/messages/approve" && m === "POST") {
    const ids = ((await body<{ ids: number[] }>(request)).ids ?? []).slice(0, 100);
    let ok = 0;
    for (const id of ids) {
      try {
        await patchMessage(env, Number(id), { status: "approved" }, user);
        ok++;
      } catch {
        // Already sent or gone: nothing to approve.
      }
    }
    return json({ ok });
  }
  if (seg[0] === "messages" && seg[1]) {
    const id = int(seg[1]);
    if (!seg[2] && m === "PATCH") {
      await patchMessage(env, id, await body(request), user);
      return json({ ok: true });
    }
    // A contact form the runner couldn't finish, done by hand.
    if (seg[2] === "sent" && m === "POST") {
      await markSent(env, id, {}, user);
      return json({ ok: true });
    }
  }
  if (seg[0] === "enrollments" && seg[1] && seg[2] === "stop" && m === "POST") {
    await stopEnrollment(env, int(seg[1]));
    return json({ ok: true });
  }

  // Sources
  if (path === "/searches" && m === "GET") return json(await listSearches(env));
  if (path === "/searches" && m === "POST") return json({ id: await saveSearch(env, null, await body(request)) }, 201);
  if (seg[0] === "searches" && seg[1]) {
    const id = int(seg[1]);
    if (!seg[2] && m === "PATCH") return json({ id: await saveSearch(env, id, await body(request)) });
    if (!seg[2] && m === "DELETE") {
      await deleteSearch(env, id);
      return json({ ok: true });
    }
    if (seg[2] === "run" && m === "POST") return json(await runSearch(env, id));
  }

  if (path === "/demo-seed" && m === "POST") {
    if (!isMock(request, env)) throw new HttpError(403, "demo data can only be loaded in local MOCK mode");
    return json(await seedDemo(env));
  }

  throw new HttpError(404, "not found");
}

async function agentRoutes(request: Request, env: Env, path: string, agent: string): Promise<Response> {
  const url = new URL(request.url);
  const m = request.method;
  const seg = path.split("/").filter(Boolean);

  if (path === "/buybox" && m === "GET") return json(await buyBox(env));
  if (path === "/listings" && m === "GET") return json(await listListings(env, filters(url.searchParams)));
  if (path === "/listings" && m === "POST") {
    const b = await body<{ listings: ListingInput[] }>(request);
    if (!Array.isArray(b.listings) || !b.listings.length) throw new HttpError(400, "listings must be a non-empty array");
    if (b.listings.length > 100) throw new HttpError(400, "send at most 100 listings per call");
    return json(await upsertListings(env, b.listings, agent));
  }
  if (seg[0] === "listings" && seg[1] && !seg[2] && m === "GET") return json(await getDetail(env, int(seg[1])));
  if (seg[0] === "listings" && seg[1] && seg[2] === "notes" && m === "POST") {
    await addNote(env, int(seg[1]), agent, (await body<{ body: string }>(request)).body ?? "");
    return json({ ok: true });
  }

  // The browser runner: asks for work, reads pages in a real browser, reports back.
  if (path === "/work" && m === "POST") {
    const b = await body<{ capabilities?: string[]; version?: string }>(request).catch(() => ({}) as { capabilities?: string[]; version?: string });
    const caps = b.capabilities ?? ["source", "contact"];
    await heartbeat(env, `runner:${agent}`, { capabilities: caps, version: b.version ?? null });
    if (caps.includes("contact")) {
      const c = await nextContactTask(env);
      if (c.task) return json({ task: c.task });
    }
    if (caps.includes("source")) {
      const s = await claimBrowserSearch(env);
      if (s) return json({ task: s });
    }
    return json({ task: null });
  }
  if (path === "/known" && m === "POST") {
    const urls = ((await body<{ urls: string[] }>(request)).urls ?? []).slice(0, 300).map(String);
    return json({ unseen: await unseen(env, urls) });
  }
  // The runner sends a search page's HTML; the hub answers with the listing links on it that are new.
  if (path === "/links" && m === "POST") {
    const b = await body<{ url: string; html: string }>(request);
    const links = listingLinks(String(b.url ?? ""), String(b.html ?? "").slice(0, 3_000_000), 80);
    return json({ links, unseen: await unseen(env, links) });
  }
  if (path === "/pages" && m === "POST") return json(await ingestPages(env, await body(request), agent));
  if (path === "/contact-result" && m === "POST") return json(await reportContact(env, agent, await body(request)));

  throw new HttpError(404, "not found");
}

interface BridgeReport {
  account?: string;
  sent?: { id: number; ok: boolean; gmailId?: string; threadId?: string; error?: string }[];
  inbound?: (InboundEmail & { kind?: "reply" | "alert"; html?: string | null })[];
}

async function gmailRoutes(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "POST only");

  // What the bridge should do now: emails to send, and where to look for replies and alerts.
  if (path === "/work") {
    const b = await body<{ account?: string }>(request).catch(() => ({}) as { account?: string });
    await heartbeat(env, "gmail_bridge", { account: b.account ?? null });
    const [{ messages, reason }, watch, s] = await Promise.all([claimDue(env, "email"), watchList(env), outreachSettings(env)]);
    return json({ send: messages, reason, fromName: s.myName || null, watchThreads: watch.threads, watchSenders: watch.senders, alertDomains: ALERT_DOMAINS });
  }

  if (path === "/report") {
    const b = await body<BridgeReport>(request);
    const out = { sent: 0, failed: 0, replies: 0, alerts: 0, newListings: 0, unmatched: 0 };
    for (const r of b.sent ?? []) {
      if (r.ok) {
        await markSent(env, Number(r.id), { gmailId: r.gmailId ?? null, threadId: r.threadId ?? null, from: b.account ?? null }, "gmail");
        out.sent++;
      } else {
        await markFailed(env, Number(r.id), r.error ?? "Gmail refused the message");
        out.failed++;
      }
    }
    for (const mail of (b.inbound ?? []).slice(0, 80)) {
      if (!mail?.id || !mail.from) continue;
      if (mail.kind === "alert" || isAlertSender(mail.from)) {
        const a = await ingestAlert(env, { from: mail.from, subject: mail.subject ?? "", html: mail.html, text: mail.text });
        if (a.found) {
          out.alerts++;
          out.newListings += a.created;
          continue;
        }
        // Not an alert with listings: marketplaces also relay broker replies from their own domain.
      }
      const r = await handleReply(env, mail);
      if (r.duplicate) continue;
      if (r.matched) out.replies++;
      else out.unmatched++;
    }
    return json(out);
  }
  throw new HttpError(404, "not found");
}

// ---------- entry points ----------

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (path === "/api/health") {
      return json({ ok: true, mock: env.MOCK === "true", configured: { admin: (env.ADMIN_TOKEN ?? "").length >= 24, gmailBridge: (env.GMAIL_BRIDGE_TOKEN ?? "").length >= 24, agents: agentNames(env).length } });
    }
    if (path === "/api/public/summary") return json(await publicSummary(env, isMock(request, env)), 200, { "Cache-Control": "public, max-age=60" });

    if (path === "/api/admin/login" && request.method === "POST") {
      const { token } = await body<{ token?: string }>(request);
      if (!token || !isAdminToken(env, token)) throw new HttpError(401, "that token isn't right");
      return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env) });
    }
    if (path === "/api/admin/logout" && request.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearedCookie });

    if (path.startsWith("/api/admin/")) {
      const user = await adminUser(request, env);
      if (!user) throw new HttpError(401, "sign in on /admin");
      // Cookie-authenticated writes must come from our own pages.
      if (request.method !== "GET" && user !== "local-dev" && !request.headers.get("Authorization")) {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) throw new HttpError(403, "cross-site request refused");
      }
      return await adminRoutes(request, env, path.slice("/api/admin".length), user);
    }

    if (path.startsWith("/api/agent/") || path === "/mcp") {
      const agent = agentName(request, env);
      if (!agent) throw new HttpError(401, "send your agent token as Authorization: Bearer <token>");
      if (path === "/mcp") return await handleMcp(request, env, agent);
      return await agentRoutes(request, env, path.slice("/api/agent".length), agent);
    }

    if (path.startsWith("/api/gmail/")) {
      if (!isBridge(request, env)) throw new HttpError(401, "the Gmail bridge token is missing or wrong");
      return await gmailRoutes(request, env, path.slice("/api/gmail".length));
    }

    if (path.startsWith("/api/")) throw new HttpError(404, "not found");
    return env.ASSETS.fetch(request);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: `Something went wrong on the hub: ${(e as Error).message}` }, 500);
  }
}

export default {
  fetch: handle,
  /** Cron: run the saved searches that are due and retire listings that vanished from their source. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await runDueSearches(env, 2);
        await expireStale(env);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
