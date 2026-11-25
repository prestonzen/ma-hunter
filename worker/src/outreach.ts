import { db, getSetting, logEvent, parseJson } from "./db";
import { buyBox, getListing, hydrate } from "./listings";
import { extractSignals } from "./parse";
import { DAY, HttpError } from "./types";
import type { BuyBox, Contact, Env, Listing, Message, OutreachSettings, Sequence, SequenceStep, Template } from "./types";

/**
 * Outreach: templates, sequences and the message queue.
 *
 * A sequence is an ordered list of templates with a delay between them. Enrolling a listing (or a
 * broker) writes the first message into the queue. Nothing leaves without approval unless the sequence
 * says so: the first message of a sequence waits as a draft, follow-ups are approved automatically by
 * default. When a message is sent the next step is scheduled; when a reply arrives the sequence stops.
 *
 * Two channels. "email" messages are sent from the owner's own Gmail by the bridge script
 * (integrations/gmail-bridge.gs) and follow-ups go into the same thread. "form" messages are typed into
 * a marketplace's contact form by the browser runner (runner/), for listings that publish no email.
 */

export const DEFAULT_OUTREACH: OutreachSettings = {
  myName: "",
  myCompany: "",
  myPhone: "",
  myEmail: "",
  buyerIntro: "",
  signature: "",
  dailyCap: 25,
  formDailyCap: 15,
  perPoll: 3,
  windowStart: 8,
  windowEnd: 18,
  weekdaysOnly: true,
  timezone: "America/New_York",
  paused: false,
};

export async function outreachSettings(env: Env): Promise<OutreachSettings> {
  return { ...DEFAULT_OUTREACH, ...((await getSetting<Partial<OutreachSettings>>(env, "outreach")) ?? {}) };
}

/** True when `now` falls inside the configured sending hours, in the configured timezone. */
export function inWindow(s: OutreachSettings, now = new Date()): boolean {
  let hour: number;
  let weekday: string;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: s.timezone || "UTC", hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
    hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
    weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  } catch {
    hour = now.getUTCHours();
    weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][now.getUTCDay()];
  }
  if (s.weekdaysOnly && (weekday === "Sat" || weekday === "Sun")) return false;
  return hour >= s.windowStart && hour < s.windowEnd;
}

// ---------- templates ----------

const SEED_TEMPLATES: { name: string; subject: string; body: string }[] = [
  {
    name: "Listing inquiry",
    subject: "Inquiry about {{business}}{{ref_suffix}}",
    body: "Hi {{first_name}},\n\nI came across {{business}} on {{source}}{{price_clause}} and would like to learn more. {{buyer_intro}}\n\nA few questions to see whether it's a fit:\n{{questions}}\n\nI'm glad to sign an NDA to review the financials. What's the best way to move forward?\n\n{{signature}}",
  },
  {
    name: "Follow-up 1",
    subject: "Re: Inquiry about {{business}}{{ref_suffix}}",
    body: "Hi {{first_name}},\n\nFollowing up on my note about {{business}}. Is it still available? I can sign an NDA today and move quickly if the numbers hold up.\n\n{{signature}}",
  },
  {
    name: "Follow-up 2",
    subject: "Re: Inquiry about {{business}}{{ref_suffix}}",
    body: "Hi {{first_name}},\n\nOne last check on {{business}}. If it's under contract or off the market, no problem. I'm looking at similar businesses too, so if you have anything comparable I'd like to see it.\n\n{{signature}}",
  },
  {
    name: "Broker introduction",
    subject: "Buyer looking for {{buy_box_short}}",
    body: "Hi {{first_name}},\n\n{{buyer_intro}} I'm actively looking to acquire a business and wanted to introduce myself in case you have something that fits, on or off market.\n\nWhat I'm looking for:\n{{buy_box}}\n\nIf anything comes to mind, I'd be glad to sign an NDA and take a look.\n\n{{signature}}",
  },
  {
    name: "Broker follow-up",
    subject: "Re: Buyer looking for {{buy_box_short}}",
    body: "Hi {{first_name}},\n\nChecking back in case anything new has come across your desk that fits what I'm looking for. Happy to jump on a quick call if that's easier.\n\n{{signature}}",
  },
  {
    name: "Marketplace form inquiry",
    subject: "Inquiry about {{business}}",
    body: "Hi {{first_name}},\n\nI'm interested in {{business}}{{price_clause}}. {{buyer_intro}}\n\n{{questions}}\n\nI can sign an NDA to review the financials. Best way to reach me is {{my_email}}{{phone_clause}}.\n\n{{my_name}}",
  },
];

async function seedOutreach(env: Env): Promise<void> {
  const d = await db(env);
  const n = await d.prepare("SELECT COUNT(*) AS n FROM templates").first<{ n: number }>();
  if ((n?.n ?? 0) > 0) return;
  const now = Date.now();
  const ids: number[] = [];
  for (const t of SEED_TEMPLATES) {
    const r = await d.prepare("INSERT INTO templates (name, subject, body, updatedAt) VALUES (?, ?, ?, ?) RETURNING id").bind(t.name, t.subject, t.body, now).first<{ id: number }>();
    ids.push(r!.id);
  }
  const seq = (name: string, target: string, channel: string, steps: SequenceStep[]) =>
    d.prepare("INSERT INTO sequences (name, target, channel, steps, autoFollowups, autoFirst, enabled) VALUES (?, ?, ?, ?, 1, 0, 1)").bind(name, target, channel, JSON.stringify(steps));
  await d.batch([
    seq("Listing inquiry by email (3 touches)", "listing", "email", [{ templateId: ids[0], delayDays: 0 }, { templateId: ids[1], delayDays: 4 }, { templateId: ids[2], delayDays: 7 }]),
    seq("Marketplace contact form", "listing", "form", [{ templateId: ids[5], delayDays: 0 }]),
    seq("Broker introduction (2 touches)", "broker", "email", [{ templateId: ids[3], delayDays: 0 }, { templateId: ids[4], delayDays: 7 }]),
  ]);
}

export async function listTemplates(env: Env): Promise<Template[]> {
  await seedOutreach(env);
  const { results } = await (await db(env)).prepare("SELECT * FROM templates ORDER BY id").all<Template>();
  return results;
}

export async function saveTemplate(env: Env, id: number | null, t: Partial<Template>): Promise<number> {
  const d = await db(env);
  const name = (t.name ?? "").trim().slice(0, 120);
  const subject = (t.subject ?? "").trim().slice(0, 200);
  const body = (t.body ?? "").replace(/\r/g, "").trim().slice(0, 6000);
  if (!name || !body) throw new HttpError(400, "a template needs a name and a body");
  if (id) {
    await d.prepare("UPDATE templates SET name = ?, subject = ?, body = ?, updatedAt = ? WHERE id = ?").bind(name, subject, body, Date.now(), id).run();
    return id;
  }
  const r = await d.prepare("INSERT INTO templates (name, subject, body, updatedAt) VALUES (?, ?, ?, ?) RETURNING id").bind(name, subject, body, Date.now()).first<{ id: number }>();
  return r!.id;
}

export async function deleteTemplate(env: Env, id: number): Promise<void> {
  const seqs = await listSequences(env);
  const used = seqs.find((s) => s.steps.some((st) => st.templateId === id));
  if (used) throw new HttpError(409, `"${used.name}" uses this template; remove it from the sequence first`);
  await (await db(env)).prepare("DELETE FROM templates WHERE id = ?").bind(id).run();
}

// ---------- sequences ----------

type SeqRow = Omit<Sequence, "steps"> & { steps: string };
const toSequence = (r: SeqRow): Sequence => ({ ...r, steps: parseJson<SequenceStep[]>(r.steps, []) });

export async function listSequences(env: Env): Promise<(Sequence & { active: number; replied: number; total: number })[]> {
  await seedOutreach(env);
  const { results } = await (await db(env))
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM enrollments e WHERE e.sequenceId = s.id) AS total,
              (SELECT COUNT(*) FROM enrollments e WHERE e.sequenceId = s.id AND e.status = 'active') AS active,
              (SELECT COUNT(*) FROM enrollments e WHERE e.sequenceId = s.id AND e.status = 'replied') AS replied
         FROM sequences s ORDER BY s.id`,
    )
    .all<SeqRow & { active: number; replied: number; total: number }>();
  return results.map((r) => ({ ...toSequence(r), active: r.active, replied: r.replied, total: r.total }));
}

export async function saveSequence(env: Env, id: number | null, s: Partial<Sequence>): Promise<number> {
  const d = await db(env);
  const name = (s.name ?? "").trim().slice(0, 120);
  const steps = (s.steps ?? []).map((st) => ({ templateId: Number(st.templateId), delayDays: Math.max(0, Math.min(90, Math.round(Number(st.delayDays) || 0))) })).filter((st) => st.templateId > 0);
  if (!name || !steps.length) throw new HttpError(400, "a sequence needs a name and at least one step");
  const channel = s.channel === "form" ? "form" : "email";
  const target = s.target === "broker" ? "broker" : "listing";
  if (channel === "form" && target !== "listing") throw new HttpError(400, "contact forms belong to listings");
  // A marketplace form is a single message: repeat submissions to a broker's form read as spam.
  const finalSteps = channel === "form" ? steps.slice(0, 1) : steps;
  finalSteps[0].delayDays = 0;
  const vals = [name, target, channel, JSON.stringify(finalSteps), s.autoFollowups === 0 ? 0 : 1, s.autoFirst ? 1 : 0, s.enabled === 0 ? 0 : 1];
  if (id) {
    await d.prepare("UPDATE sequences SET name = ?, target = ?, channel = ?, steps = ?, autoFollowups = ?, autoFirst = ?, enabled = ? WHERE id = ?").bind(...vals, id).run();
    return id;
  }
  const r = await d.prepare("INSERT INTO sequences (name, target, channel, steps, autoFollowups, autoFirst, enabled) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id").bind(...vals).first<{ id: number }>();
  return r!.id;
}

// ---------- rendering ----------

const usd = (n: number | null | undefined) => (n == null ? "" : n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e5 ? 2 : 1).replace(/\.0$/, "")}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`);

/** The questions worth asking are the ones the listing leaves open. */
export function questionsFor(l: Listing): string[] {
  const q: string[] = [];
  if (l.sellerFinancing === "unknown") q.push("Is the seller open to financing part of the purchase price?");
  if (!l.reasonForSelling) q.push("Why is the owner selling?");
  if (l.ownerStays === "unknown") q.push("Would the owner stay on through a transition, and for how long?");
  if (l.remoteManageable === "unknown" || l.ownerRole === "unknown") q.push("How involved is the owner day to day, and could the business be managed remotely?");
  if (l.cashFlow == null && l.ebitda == null) q.push("What were revenue and owner's cash flow (SDE) for the last full year?");
  if (!l.listedAt) q.push("How long has it been on the market, and have there been any offers?");
  if (l.employees == null) q.push("How many employees are there, and is there a manager in place?");
  if (!q.length) q.push("Are the last three years of P&Ls and tax returns available under NDA?");
  return q.slice(0, 4);
}

export function buyBoxText(box: BuyBox): { long: string; short: string } {
  const lines: string[] = [];
  if (box.industriesInclude.length) lines.push(`- Industries: ${box.industriesInclude.join(", ")}`);
  if (box.priceMin != null || box.priceMax != null) lines.push(`- Asking price: ${box.priceMin != null ? usd(box.priceMin) : "any"} to ${box.priceMax != null ? usd(box.priceMax) : "open"}`);
  if (box.cashFlowMin != null) lines.push(`- Cash flow (SDE): ${usd(box.cashFlowMin)}+`);
  if (box.locations.length) lines.push(`- Location: ${box.locations.join(", ")}${box.requireRemote ? " or remotely manageable" : ""}`);
  else if (box.requireRemote) lines.push("- Location: anywhere, as long as it can be managed remotely");
  if (box.preferSellerFinancing) lines.push("- Open to seller financing or an SBA-backed structure");
  if (box.preferOwnerStays) lines.push("- Ideally the owner stays through a transition period");
  if (box.synergyProfile.trim()) lines.push(`- Background: ${box.synergyProfile.trim()}`);
  const short = box.industriesInclude.length ? `${box.industriesInclude.slice(0, 2).join(" / ")} businesses` : "a business to acquire";
  return { long: lines.join("\n") || "- A profitable, established business with clean books", short };
}

export function templateVars(l: Listing | null, c: Pick<Contact, "name" | "company"> | null, s: OutreachSettings, box: BuyBox): Record<string, string> {
  const first = (c?.name ?? "").trim().split(/\s+/)[0] ?? "";
  // "John Smith, CBI" -> John; a company-only contact or an ALL-CAPS brokerage name gets "there".
  const firstName = first && /^[A-Za-z][a-z'-]+$/.test(first) ? first : "there";
  const bb = buyBoxText(box);
  const numericRef = l && /^\d{4,}$/.test(l.sourceId) ? l.sourceId : "";
  const signature = s.signature.trim() || [s.myName, s.myCompany, s.myPhone].filter((x) => x.trim()).join("\n");
  return {
    first_name: firstName,
    contact_name: c?.name ?? "",
    contact_company: c?.company ?? "",
    business: l ? `"${l.title}"` : "",
    business_plain: l?.title ?? "",
    source: l ? ({ bizbuysell: "BizBuySell", bizquest: "BizQuest", flippa: "Flippa", empireflippers: "Empire Flippers", acquire: "Acquire.com", loopnet: "LoopNet", businessbroker: "BusinessBroker.net", businessesforsale: "BusinessesForSale.com", quietlight: "Quiet Light", manual: "your listing" }[l.source] ?? l.source) : "",
    listing_ref: numericRef,
    ref_suffix: numericRef ? ` (listing #${numericRef})` : "",
    listing_url: l?.url ?? "",
    asking_price: usd(l?.askingPrice),
    price_clause: l?.askingPrice ? ` (asking ${usd(l.askingPrice)})` : "",
    industry: l?.industry ?? "",
    location: l?.location ?? "",
    questions: l ? questionsFor(l).map((q) => `- ${q}`).join("\n") : "",
    my_name: s.myName,
    my_company: s.myCompany,
    my_phone: s.myPhone,
    my_email: s.myEmail,
    phone_clause: s.myPhone.trim() ? ` or ${s.myPhone.trim()}` : "",
    buyer_intro: s.buyerIntro.trim() || (s.myName ? `I'm ${s.myName}${s.myCompany ? ` with ${s.myCompany}` : ""}.` : ""),
    buy_box: bb.long,
    buy_box_short: bb.short,
    signature,
  };
}

export function render(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k: string) => vars[k.toLowerCase()] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

// ---------- enrolling ----------

interface Enrollment {
  id: number;
  sequenceId: number;
  listingId: number | null;
  contactId: number;
  status: "active" | "replied" | "finished" | "stopped";
  step: number;
  threadId: string | null;
}

async function createStepMessage(env: Env, e: Enrollment, seq: Sequence, step: number, scheduledAt: number): Promise<number> {
  const d = await db(env);
  const st = seq.steps[step];
  const tpl = await d.prepare("SELECT * FROM templates WHERE id = ?").bind(st.templateId).first<Template>();
  if (!tpl) throw new HttpError(409, `step ${step + 1} of "${seq.name}" points at a deleted template`);
  const contact = await d.prepare("SELECT * FROM contacts WHERE id = ?").bind(e.contactId).first<Contact>();
  const listing = e.listingId ? await getListing(env, e.listingId) : null;
  const vars = templateVars(listing, contact, await outreachSettings(env), await buyBox(env));
  const auto = step === 0 ? seq.autoFirst : seq.autoFollowups;
  const r = await d
    .prepare("INSERT INTO messages (enrollmentId, listingId, contactId, direction, channel, step, url, toEmail, subject, body, status, scheduledAt, createdAt) VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(e.id, e.listingId, e.contactId, seq.channel, step, seq.channel === "form" ? (listing?.url ?? null) : null, seq.channel === "email" ? (contact?.email ?? null) : null, render(tpl.subject, vars).slice(0, 200), render(tpl.body, vars), auto ? "approved" : "draft", scheduledAt, Date.now())
    .first<{ id: number }>();
  return r!.id;
}

export async function getSequence(env: Env, id: number): Promise<Sequence> {
  const r = await (await db(env)).prepare("SELECT * FROM sequences WHERE id = ?").bind(id).first<SeqRow>();
  if (!r) throw new HttpError(404, "sequence not found");
  return toSequence(r);
}

/** Start a sequence for a listing (its contact, or its contact form) or for a broker on their own. */
export async function enroll(env: Env, a: { sequenceId: number; listingId?: number | null; contactId?: number | null }, actor: string): Promise<{ enrollmentId: number; messageId: number }> {
  const d = await db(env);
  const seq = await getSequence(env, a.sequenceId);
  if (!seq.enabled) throw new HttpError(409, `"${seq.name}" is switched off`);
  let listing: Listing | null = null;
  let contactId = a.contactId ?? null;
  if (seq.target === "listing") {
    if (!a.listingId) throw new HttpError(400, "this sequence needs a listing");
    listing = await getListing(env, a.listingId);
    if (listing.status === "sold" || listing.status === "removed") throw new HttpError(409, `this listing is ${listing.status}`);
    contactId ??= listing.contactId;
    if (seq.channel === "form" && !listing.url) throw new HttpError(409, "this listing has no page URL to contact through");
  }
  if (seq.channel === "form" && !contactId) {
    // Form inquiries don't need to know who's on the other side yet; a placeholder contact holds the thread.
    const r = await d.prepare("INSERT INTO contacts (name, company, role, createdAt) VALUES (NULL, ?, 'broker', ?) RETURNING id").bind(`${listing!.source} listing ${listing!.sourceId}`, Date.now()).first<{ id: number }>();
    contactId = r!.id;
    await d.prepare("UPDATE listings SET contactId = ? WHERE id = ? AND contactId IS NULL").bind(contactId, listing!.id).run();
  }
  if (!contactId) throw new HttpError(409, "no contact on this listing yet: add the broker's email, or use the contact-form sequence");
  const contact = await d.prepare("SELECT * FROM contacts WHERE id = ?").bind(contactId).first<Contact>();
  if (!contact) throw new HttpError(404, "contact not found");
  if (contact.doNotContact) throw new HttpError(409, `${contact.name ?? contact.email ?? "this contact"} is marked do-not-contact`);
  if (seq.channel === "email" && !contact.email) throw new HttpError(409, "this contact has no email address: add one, or use the contact-form sequence");

  const active = await d
    .prepare("SELECT id FROM enrollments WHERE status = 'active' AND contactId = ?1 AND ((?2 IS NULL AND listingId IS NULL) OR listingId = ?2) LIMIT 1")
    .bind(contactId, listing?.id ?? null)
    .first();
  if (active) throw new HttpError(409, "there is already an active sequence for this contact here");

  const now = Date.now();
  const e = await d
    .prepare("INSERT INTO enrollments (sequenceId, listingId, contactId, status, step, createdAt, updatedAt) VALUES (?, ?, ?, 'active', 0, ?, ?) RETURNING *")
    .bind(seq.id, listing?.id ?? null, contactId, now, now)
    .first<Enrollment>();
  const messageId = await createStepMessage(env, e!, seq, 0, now);
  await logEvent(env, { actor, listingId: listing?.id ?? null, type: "enrolled", message: `Started "${seq.name}"${seq.autoFirst ? "" : " (first message waits for approval)"}` });
  return { enrollmentId: e!.id, messageId };
}

export async function stopEnrollment(env: Env, enrollmentId: number, status: "stopped" | "replied" | "finished" = "stopped"): Promise<void> {
  const d = await db(env);
  await d.batch([
    d.prepare("UPDATE enrollments SET status = ?, updatedAt = ? WHERE id = ?").bind(status, Date.now(), enrollmentId),
    d.prepare("UPDATE messages SET status = 'skipped' WHERE enrollmentId = ? AND status IN ('draft', 'approved', 'failed', 'needs_human')").bind(enrollmentId),
  ]);
}

// ---------- the queue ----------

const MESSAGE_SELECT = `SELECT m.*, l.title AS listingTitle, c.name AS contactName, s.name AS sequenceName
  FROM messages m LEFT JOIN listings l ON l.id = m.listingId LEFT JOIN contacts c ON c.id = m.contactId
  LEFT JOIN enrollments e ON e.id = m.enrollmentId LEFT JOIN sequences s ON s.id = e.sequenceId`;

export async function listMessages(env: Env, f: { status?: string; direction?: string; limit?: number }): Promise<Message[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) {
    const vals = f.status.split(",").filter(Boolean);
    where.push(`m.status IN (${vals.map(() => "?").join(",")})`);
    args.push(...vals);
  }
  if (f.direction) (where.push("m.direction = ?"), args.push(f.direction));
  const { results } = await (await db(env))
    .prepare(`${MESSAGE_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(m.sentAt, m.scheduledAt, m.createdAt) DESC, m.id DESC LIMIT ?`)
    .bind(...args, Math.min(f.limit ?? 200, 500))
    .all<Message>();
  return results;
}

export async function patchMessage(env: Env, id: number, p: { subject?: string; body?: string; status?: string; scheduledAt?: number }, actor: string): Promise<void> {
  const d = await db(env);
  const m = await d.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<Message>();
  if (!m) throw new HttpError(404, "message not found");
  if (m.direction !== "out") throw new HttpError(400, "received messages can't be edited");
  if (m.status === "sent" || m.status === "sending") throw new HttpError(409, `this message is already ${m.status}`);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (p.subject !== undefined) (sets.push("subject = ?"), vals.push(p.subject.trim().slice(0, 200)));
  if (p.body !== undefined) {
    if (p.body.trim().length < 20) throw new HttpError(400, "the message is too short to send");
    sets.push("body = ?");
    vals.push(p.body.replace(/\r/g, "").trim().slice(0, 6000));
  }
  if (p.scheduledAt !== undefined) (sets.push("scheduledAt = ?"), vals.push(p.scheduledAt));
  if (p.status !== undefined) {
    if (!["draft", "approved", "skipped"].includes(p.status)) throw new HttpError(400, "status must be draft, approved or skipped");
    sets.push("status = ?", "error = NULL", "leaseUntil = 0");
    vals.push(p.status);
  }
  if (!sets.length) return;
  await d.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
  if (p.status === "skipped" && m.enrollmentId) await stopEnrollment(env, m.enrollmentId);
  if (p.status === "approved") await logEvent(env, { actor, listingId: m.listingId, type: "approved", message: `Approved ${m.channel === "form" ? "contact-form message" : `email to ${m.toEmail}`}` });
}

/** Outbound sends in the last 24 hours on one channel, including ones in flight. */
async function sentToday(env: Env, channel: string): Promise<number> {
  const r = await (await db(env))
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND channel = ? AND ((status = 'sent' AND sentAt > ?) OR status = 'sending')")
    .bind(channel, Date.now() - DAY)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export interface DueMessage {
  id: number;
  to: string | null;
  url: string | null;
  subject: string;
  body: string;
  threadId: string | null;
  listingId: number | null;
  listingTitle: string | null;
  /** Documents to attach; the Gmail bridge fetches each from /api/gmail/attachment. */
  attachments: { id: number; filename: string }[];
}

/**
 * Messages ready to go out now on one channel, leased to the caller for ten minutes. Respects the pause
 * switch, the sending window, the daily cap and the per-poll cap, and drops anything whose sequence was
 * stopped or whose contact was marked do-not-contact after it was queued.
 */
export async function claimDue(env: Env, channel: "email" | "form", max?: number): Promise<{ messages: DueMessage[]; reason: string | null }> {
  const d = await db(env);
  const s = await outreachSettings(env);
  const now = Date.now();
  // A lease that ran out without a report means the sender died mid-flight; put those back.
  await d.prepare("UPDATE messages SET status = 'approved' WHERE status = 'sending' AND leaseUntil < ? AND channel = ?").bind(now, channel).run();
  if (s.paused) return { messages: [], reason: "Outreach is paused" };
  if (!inWindow(s, new Date(now))) return { messages: [], reason: `Outside sending hours (${s.windowStart}:00-${s.windowEnd}:00 ${s.timezone}${s.weekdaysOnly ? ", weekdays" : ""})` };
  const cap = channel === "email" ? s.dailyCap : s.formDailyCap;
  const room = cap - (await sentToday(env, channel));
  if (room <= 0) return { messages: [], reason: `Daily cap of ${cap} reached` };
  const limit = Math.max(0, Math.min(max ?? s.perPoll, s.perPoll, room));

  const { results } = await d
    .prepare(
      `SELECT m.id, m.toEmail, m.url, m.subject, m.body, m.listingId, m.enrollmentId, l.title AS listingTitle, l.status AS listingStatus,
              COALESCE(e.threadId, m.threadId) AS threadId, e.status AS enrollmentStatus, c.doNotContact, m.attachDocId, doc.filename AS attachName
         FROM messages m LEFT JOIN enrollments e ON e.id = m.enrollmentId LEFT JOIN contacts c ON c.id = m.contactId LEFT JOIN listings l ON l.id = m.listingId
         LEFT JOIN documents doc ON doc.id = m.attachDocId
        WHERE m.direction = 'out' AND m.channel = ?1 AND m.status = 'approved' AND m.scheduledAt <= ?2
        ORDER BY m.scheduledAt ASC LIMIT ?3`,
    )
    .bind(channel, now, limit + 5)
    .all<{ id: number; toEmail: string | null; url: string | null; subject: string; body: string; listingId: number | null; enrollmentId: number | null; listingTitle: string | null; listingStatus: string | null; threadId: string | null; enrollmentStatus: string | null; doNotContact: number | null; attachDocId: number | null; attachName: string | null }>();

  const out: DueMessage[] = [];
  for (const m of results) {
    if (out.length >= limit) break;
    const dead = m.doNotContact ? "contact is do-not-contact" : m.enrollmentStatus && m.enrollmentStatus !== "active" ? `sequence ${m.enrollmentStatus}` : m.listingStatus === "sold" || m.listingStatus === "removed" ? `listing ${m.listingStatus}` : null;
    if (dead) {
      await d.prepare("UPDATE messages SET status = 'skipped', error = ? WHERE id = ?").bind(dead, m.id).run();
      continue;
    }
    const won = await d.prepare("UPDATE messages SET status = 'sending', leaseUntil = ? WHERE id = ? AND status = 'approved'").bind(now + 10 * 60_000, m.id).run();
    if (won.meta.changes !== 1) continue;
    out.push({ id: m.id, to: m.toEmail, url: m.url, subject: m.subject, body: m.body, threadId: m.threadId, listingId: m.listingId, listingTitle: m.listingTitle, attachments: m.attachDocId && m.attachName ? [{ id: m.attachDocId, filename: m.attachName }] : [] });
  }
  return { messages: out, reason: null };
}

/** A message went out: record it, move the listing along, and schedule the next step of the sequence. */
export async function markSent(env: Env, id: number, r: { gmailId?: string | null; threadId?: string | null; from?: string | null }, actor: string): Promise<void> {
  const d = await db(env);
  const m = await d.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<Message>();
  if (!m) throw new HttpError(404, "message not found");
  if (m.status === "sent") return; // a repeated report
  const now = Date.now();
  await d.prepare("UPDATE messages SET status = 'sent', sentAt = ?, gmailId = ?, threadId = COALESCE(?, threadId), fromEmail = ?, error = NULL, leaseUntil = 0 WHERE id = ?").bind(now, r.gmailId ?? null, r.threadId ?? null, r.from ?? null, id).run();

  if (m.listingId) {
    await d
      .prepare(
        `UPDATE listings SET contactedAt = COALESCE(contactedAt, ?1), lastContactAt = ?1, contactCount = contactCount + 1,
                stageAt = CASE WHEN stage IN ('new', 'shortlist') THEN ?1 ELSE stageAt END,
                stage = CASE WHEN stage IN ('new', 'shortlist') THEN 'contacted' ELSE stage END, updatedAt = ?1
          WHERE id = ?2`,
      )
      .bind(now, m.listingId)
      .run();
  }
  await logEvent(env, { actor, listingId: m.listingId, type: "sent", message: m.channel === "form" ? "Inquiry submitted through the listing's contact form" : `${m.step === 0 ? "Email" : `Follow-up ${m.step}`} sent to ${m.toEmail}` });

  if (!m.enrollmentId) return;
  const e = await d.prepare("SELECT * FROM enrollments WHERE id = ?").bind(m.enrollmentId).first<Enrollment>();
  if (!e) return;
  const seq = await getSequence(env, e.sequenceId).catch(() => null);
  const next = m.step + 1;
  const hasNext = !!seq && e.status === "active" && next < seq.steps.length;
  await d.prepare("UPDATE enrollments SET step = ?, threadId = COALESCE(?, threadId), status = ?, updatedAt = ? WHERE id = ?").bind(m.step, r.threadId ?? null, hasNext || e.status !== "active" ? e.status : "finished", now, e.id).run();
  if (hasNext) await createStepMessage(env, { ...e, threadId: r.threadId ?? e.threadId }, seq!, next, now + seq!.steps[next].delayDays * DAY);
}

export async function markFailed(env: Env, id: number, error: string, needsHuman = false): Promise<void> {
  const d = await db(env);
  const m = await d.prepare("SELECT listingId, channel FROM messages WHERE id = ?").bind(id).first<{ listingId: number | null; channel: string }>();
  if (!m) return;
  await d.prepare("UPDATE messages SET status = ?, error = ?, leaseUntil = 0 WHERE id = ? AND status != 'sent'").bind(needsHuman ? "needs_human" : "failed", error.slice(0, 400), id).run();
  await logEvent(env, { actor: "hub", listingId: m.listingId, type: needsHuman ? "needs_human" : "failed", message: `${m.channel === "form" ? "Contact form" : "Email"}: ${error.slice(0, 200)}` });
}

// ---------- replies ----------

export type ReplyClass = "interested" | "nda" | "proof_of_funds" | "call" | "sold" | "not_interested" | "auto_reply" | "bounce";

/** A rough read of a broker's reply, enough to route it. The admin sees the full text either way. */
export function classifyReply(subject: string, text: string, from = ""): ReplyClass {
  const body = text.split(/\n(?:On .{5,80} wrote:|-{2,} ?Original Message ?-{2,}|From: .+\nSent: )/i)[0]; // drop the quoted thread
  const all = `${subject}\n${body}`.toLowerCase();
  if (/mailer-daemon|postmaster@|mail delivery subsystem/i.test(from) || /delivery (?:status notification|has failed|failure)|undeliverable|address (?:not found|couldn't be found)|user unknown|mailbox (?:not found|unavailable|full)/.test(all)) return "bounce";
  if (/automatic reply|auto[- ]?reply|out of (?:the )?office|on vacation|away from (?:my|the) (?:desk|office)|limited access to (?:my )?email|will respond (?:as soon as|when i return)/.test(all)) return "auto_reply";
  if (/\b(?:has (?:been )?sold|is sold|already sold|under contract|under (?:an )?loi|accepted an offer|offer (?:has been )?accepted|no longer (?:available|for sale|on the market)|off the market|sale (?:is )?pending|in escrow|closed last)\b/.test(all)) return "sold";
  if (/\b(?:not (?:a (?:good )?fit|interested|moving forward)|we(?:'ll| will) pass|decided not to|remove me|unsubscribe|stop (?:emailing|contacting)|do not contact)\b/.test(all)) return "not_interested";
  if (/\b(?:nda|non[- ]?disclosure|confidentiality agreement|\bca\b attached|sign the attached)\b/.test(all)) return "nda";
  if (/\b(?:proof of funds|pof\b|buyer (?:profile|questionnaire)|personal financial statement|financial (?:qualification|capability)|pre[- ]?qualif|liquid(?:ity| assets)|net worth)\b/.test(all)) return "proof_of_funds";
  if (/\b(?:(?:schedule|set up|hop on|jump on|arrange|have) (?:a |an )?(?:quick |brief |intro(?:ductory)? )?(?:call|zoom|meeting|chat)|give me a call|call me|what(?:'s| is) (?:a good|your) (?:number|time)|are you available|calendly\.com|let(?:'s| us) (?:talk|connect|chat))\b/.test(all)) return "call";
  return "interested";
}

export interface InboundEmail {
  id: string;
  threadId?: string | null;
  from: string;
  subject: string;
  date?: string;
  text: string;
}

const emailOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? "").toLowerCase();

/**
 * A reply from a broker or owner. Matched to its sequence by Gmail thread, else by the sender's address,
 * else by a listing number or title mentioned in the mail (replies to contact-form inquiries arrive as
 * new threads). Stops the sequence, files the message, moves the listing, and reads the reply for the
 * things worth knowing: is financing on the table, why are they selling, will the owner stay.
 */
export async function handleReply(env: Env, mail: InboundEmail): Promise<{ matched: boolean; listingId: number | null; classification: ReplyClass | null; duplicate?: boolean }> {
  const d = await db(env);
  if (await d.prepare("SELECT 1 AS x FROM messages WHERE gmailId = ?").bind(mail.id).first()) return { matched: true, listingId: null, classification: null, duplicate: true };
  const from = emailOf(mail.from);
  const text = (mail.text ?? "").slice(0, 12_000);
  const cls = classifyReply(mail.subject ?? "", text, mail.from);

  let e: Enrollment | null = null;
  if (mail.threadId) e = await d.prepare("SELECT * FROM enrollments WHERE threadId = ? ORDER BY id DESC LIMIT 1").bind(mail.threadId).first<Enrollment>();
  let contactId: number | null = e?.contactId ?? null;
  let listingId: number | null = e?.listingId ?? null;
  if (!e && from) {
    const c = await d.prepare("SELECT id FROM contacts WHERE email = ?").bind(from).first<{ id: number }>();
    if (c) {
      contactId = c.id;
      e = await d.prepare("SELECT * FROM enrollments WHERE contactId = ? ORDER BY (status = 'active') DESC, id DESC LIMIT 1").bind(c.id).first<Enrollment>();
      listingId = e?.listingId ?? (await d.prepare("SELECT id FROM listings WHERE contactId = ? AND contactedAt IS NOT NULL ORDER BY lastContactAt DESC LIMIT 1").bind(c.id).first<{ id: number }>())?.id ?? null;
    }
  }
  if (!e && !listingId) {
    // Contact-form replies: look for a contacted listing's number or title in the mail.
    const hay = `${mail.subject}\n${text}`.toLowerCase();
    const { results } = await d.prepare("SELECT id, sourceId, title, contactId FROM listings WHERE contactedAt IS NOT NULL AND repliedAt IS NULL ORDER BY lastContactAt DESC LIMIT 300").all<{ id: number; sourceId: string; title: string; contactId: number | null }>();
    const hit = results.find((l) => (/^\d{5,}$/.test(l.sourceId) && hay.includes(l.sourceId)) || (l.title.length >= 18 && hay.includes(l.title.toLowerCase())));
    if (hit) {
      listingId = hit.id;
      e = await d.prepare("SELECT * FROM enrollments WHERE listingId = ? ORDER BY id DESC LIMIT 1").bind(hit.id).first<Enrollment>();
      contactId = e?.contactId ?? hit.contactId;
      // Now we know who answers for this listing: put a name and address on the placeholder contact.
      if (contactId && from && cls !== "bounce") {
        const name = mail.from.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || null;
        await d.prepare("UPDATE contacts SET email = COALESCE(email, ?1), name = COALESCE(name, ?2) WHERE id = ?3 AND NOT EXISTS (SELECT 1 FROM contacts WHERE email = ?1)").bind(from, name, contactId).run();
      }
    }
  }
  if (!e && !listingId && !contactId) return { matched: false, listingId: null, classification: cls };

  const now = Date.now();
  await d
    .prepare("INSERT INTO messages (enrollmentId, listingId, contactId, direction, channel, step, fromEmail, subject, body, status, sentAt, gmailId, threadId, classification, createdAt) VALUES (?, ?, ?, 'in', 'email', 0, ?, ?, ?, 'received', ?, ?, ?, ?, ?)")
    .bind(e?.id ?? null, listingId, contactId, from, (mail.subject ?? "").slice(0, 200), text, mail.date ? Date.parse(mail.date) || now : now, mail.id, mail.threadId ?? null, cls, now)
    .run();

  if (cls === "auto_reply") return { matched: true, listingId, classification: cls }; // an out-of-office is not an answer; the sequence continues

  if (e && e.status === "active") await stopEnrollment(env, e.id, cls === "bounce" ? "stopped" : "replied");
  if (cls === "bounce") {
    await logEvent(env, { actor: "gmail", listingId, type: "bounce", message: `Email to ${from || "the contact"} bounced: check the address` });
    return { matched: true, listingId, classification: cls };
  }
  if (cls === "not_interested" && contactId && /remove me|unsubscribe|stop (?:emailing|contacting)|do not contact/i.test(text)) {
    await d.prepare("UPDATE contacts SET doNotContact = 1 WHERE id = ?").bind(contactId).run();
  }

  if (listingId) {
    const row = await d.prepare("SELECT * FROM listings WHERE id = ?").bind(listingId).first<Record<string, unknown>>();
    if (row) {
      const l = hydrate(row);
      const sets: Record<string, unknown> = { repliedAt: now, updatedAt: now };
      if (["new", "shortlist", "contacted"].includes(l.stage) && cls !== "sold" && cls !== "not_interested") Object.assign(sets, { stage: "conversation", stageAt: now });
      if (cls === "sold" && !l.locked.includes("status")) sets.status = "sold";
      if (cls === "nda" && l.ndaStatus === "none") sets.ndaStatus = "requested";
      // What the reply tells us that the listing didn't.
      const sig = extractSignals(text.split(/\nOn .{5,80} wrote:/)[0]);
      const learned: string[] = [];
      if (l.sellerFinancing === "unknown" && sig.sellerFinancing !== "unknown" && !l.locked.includes("sellerFinancing")) {
        Object.assign(sets, { sellerFinancing: sig.sellerFinancing, financingNotes: sig.financingNotes });
        learned.push(`seller financing: ${sig.sellerFinancing}`);
      }
      if (!l.reasonForSelling && sig.reasonForSelling && !l.locked.includes("reasonForSelling")) {
        sets.reasonForSelling = sig.reasonForSelling;
        learned.push(`reason for selling: ${sig.reasonForSelling}`);
      }
      if (l.ownerStays === "unknown" && sig.ownerStays !== "unknown" && !l.locked.includes("ownerStays")) {
        Object.assign(sets, { ownerStays: sig.ownerStays, transitionNotes: sig.transitionNotes });
        learned.push(`owner stays: ${sig.ownerStays}`);
      }
      const cols = Object.keys(sets);
      await d.prepare(`UPDATE listings SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).bind(...cols.map((c) => sets[c] ?? null), listingId).run();
      await logEvent(env, { actor: "gmail", listingId, type: "reply", message: `Reply from ${from || "the contact"} (${cls.replace(/_/g, " ")})${learned.length ? `. Learned: ${learned.join("; ")}` : ""}` });
    }
  } else {
    await logEvent(env, { actor: "gmail", type: "reply", message: `Reply from ${from} (${cls.replace(/_/g, " ")})` });
  }
  return { matched: true, listingId, classification: cls };
}

/** Threads and senders the Gmail bridge should watch for replies. */
export async function watchList(env: Env): Promise<{ threads: string[]; senders: string[] }> {
  const d = await db(env);
  const since = Date.now() - 60 * DAY;
  const [t, s] = await d.batch<{ v: string }>([
    d.prepare("SELECT DISTINCT threadId AS v FROM enrollments WHERE threadId IS NOT NULL AND updatedAt > ? ORDER BY updatedAt DESC LIMIT 150").bind(since),
    d.prepare("SELECT DISTINCT c.email AS v FROM contacts c JOIN listings l ON l.contactId = c.id WHERE c.email IS NOT NULL AND l.contactedAt > ? ORDER BY l.lastContactAt DESC LIMIT 150").bind(since),
  ]);
  return { threads: t.results.map((r) => r.v), senders: s.results.map((r) => r.v) };
}
