import { db, getSetting, logEvent, parseJson, setSetting } from "./db";
import { getListing } from "./listings";
import { DEFAULT_NDA_TEMPLATE, buildNda, placeFields, readPdf, scanNda } from "./ndapdf";
import { outreachSettings } from "./outreach";
import { HttpError } from "./types";
import type { Contact, Env, Listing, Nda, NdaField, NdaFlag, NdaPlacement, NdaSettings } from "./types";

/**
 * NDAs, signed through your own Documenso (DOCUMENSO_URL + DOCUMENSO_TOKEN).
 *
 *   ours    The hub writes your one-way confidentiality agreement for a listing as a PDF.
 *   theirs  A broker's NDA (uploaded, or attached to their reply): the hub reads it, flags the clauses
 *           worth a look, and finds the buyer's signature line.
 *
 * Either way the document becomes a Documenso envelope with you as the only signer, and the hub keeps
 * the signing link. Documenso has no "sign" API by design: a signature is made on its signing page.
 * So an NDA is signed by you (one click from the hub), or by the browser runner on your machine for
 * the NDAs your auto-sign rule clears. Every 15 minutes the hub checks the envelopes: a completed one
 * is downloaded into the listing's documents, the listing moves to "NDA signed", and the signed copy
 * is queued back to the broker with a request for the CIM.
 */

export const DEFAULT_NDA: NdaSettings = {
  legalName: "",
  title: "",
  address: "",
  state: "",
  termYears: 2,
  autoSign: "mine",
  onRequest: "send_mine",
  returnByEmail: true,
  returnMessage: "Hi {{first_name}},\n\nThe signed NDA for {{business}} is attached. Could you send over the CIM and the last three years of financials when you have a moment?\n\n{{signature}}",
  template: DEFAULT_NDA_TEMPLATE,
};

export async function ndaSettings(env: Env): Promise<NdaSettings> {
  return { ...DEFAULT_NDA, ...((await getSetting<Partial<NdaSettings>>(env, "nda")) ?? {}) };
}

export async function saveNdaSettings(env: Env, b: Partial<NdaSettings>): Promise<NdaSettings> {
  const cur = await ndaSettings(env);
  const s: NdaSettings = {
    legalName: String(b.legalName ?? cur.legalName).trim().slice(0, 120),
    title: String(b.title ?? cur.title).trim().slice(0, 80),
    address: String(b.address ?? cur.address).trim().slice(0, 200),
    state: String(b.state ?? cur.state).trim().slice(0, 80),
    termYears: Math.max(1, Math.min(10, Math.round(Number(b.termYears ?? cur.termYears)) || 2)),
    autoSign: (["off", "mine", "clean"] as const).includes(b.autoSign as "off") ? b.autoSign! : cur.autoSign,
    onRequest: b.onRequest === "wait" || b.onRequest === "send_mine" ? b.onRequest : cur.onRequest,
    returnByEmail: b.returnByEmail ?? cur.returnByEmail,
    returnMessage: String(b.returnMessage ?? cur.returnMessage).slice(0, 2000),
    template: String(b.template ?? cur.template).trim().slice(0, 12_000) || DEFAULT_NDA_TEMPLATE,
  };
  await setSetting(env, "nda", s);
  return s;
}

export const documensoConfigured = (env: Env) => /^https?:\/\//.test(env.DOCUMENSO_URL ?? "") && (env.DOCUMENSO_TOKEN ?? "").length >= 16;

// ---------- Documenso ----------

async function dz<T>(env: Env, method: "GET" | "POST", path: string, body?: unknown | FormData): Promise<T> {
  if (!documensoConfigured(env)) throw new HttpError(409, "Documenso isn't connected: set the DOCUMENSO_TOKEN secret (an API token from your Documenso settings)");
  const form = body instanceof FormData;
  const res = await fetch(`${env.DOCUMENSO_URL!.replace(/\/+$/, "")}/api/v2${path}`, {
    method,
    headers: { Authorization: env.DOCUMENSO_TOKEN!, Accept: "application/json", ...(body && !form ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const msg = parseJson<{ message?: string }>(text, {}).message ?? text;
    throw new HttpError(res.status === 401 || res.status === 403 ? 409 : 502, `Documenso answered ${res.status}${msg ? `: ${msg}` : ""}`);
  }
  return (await res.json()) as T;
}

interface Envelope {
  id: string;
  status: "DRAFT" | "PENDING" | "COMPLETED" | "REJECTED" | "CANCELLED";
  recipients: { email: string; role: string; signingStatus: string; token: string }[];
  envelopeItems: { id: string; order: number }[];
}

/** Upload a PDF as an envelope with one signer, start it without Documenso emailing anyone, and return the signing link. */
async function openEnvelope(env: Env, a: { title: string; filename: string; bytes: Uint8Array; signer: { name: string; email: string }; fields: NdaField[]; externalId: string }): Promise<{ envelopeId: string; signingUrl: string }> {
  const payload = {
    title: a.title.slice(0, 250),
    type: "DOCUMENT",
    externalId: a.externalId,
    recipients: [
      {
        email: a.signer.email,
        name: a.signer.name,
        role: "SIGNER",
        signingOrder: 1,
        fields: a.fields.map((f) => ({
          type: f.type,
          page: f.page,
          positionX: f.positionX,
          positionY: f.positionY,
          width: f.width,
          height: f.height,
          ...(f.type === "TEXT" ? { fieldMeta: { type: "text", text: f.text ?? "", readOnly: true, required: false, fontSize: 10 } } : {}),
        })),
      },
    ],
    meta: { distributionMethod: "NONE", typedSignatureEnabled: true, drawSignatureEnabled: true, uploadSignatureEnabled: true },
  };
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  form.append("files", new File([a.bytes], a.filename, { type: "application/pdf" }));
  const created = await dz<{ id: string }>(env, "POST", "/envelope/create", form);
  const sent = await dz<{ recipients: { role: string; signingUrl: string }[] }>(env, "POST", "/envelope/distribute", { envelopeId: created.id, meta: { distributionMethod: "NONE" } });
  const url = sent.recipients.find((r) => r.role === "SIGNER")?.signingUrl;
  if (!url) throw new HttpError(502, "Documenso started the envelope but returned no signing link");
  return { envelopeId: created.id, signingUrl: url };
}

// ---------- storage ----------

async function putDoc(env: Env, listingId: number, filename: string, bytes: ArrayBuffer | Uint8Array, kind: "nda" | "other"): Promise<number> {
  const now = Date.now();
  const safe = filename.replace(/[^\w.() -]+/g, "_").slice(0, 140) || "nda.pdf";
  const key = `docs/${listingId}/${now}-${safe}`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const row = await (await db(env))
    .prepare("INSERT INTO documents (listingId, key, filename, contentType, size, kind, uploadedAt) VALUES (?, ?, ?, 'application/pdf', ?, ?, ?) RETURNING id")
    .bind(listingId, key, safe, bytes.byteLength, kind, now)
    .first<{ id: number }>();
  return row!.id;
}

async function docBytes(env: Env, docId: number): Promise<{ bytes: ArrayBuffer; filename: string }> {
  const row = await (await db(env)).prepare("SELECT key, filename FROM documents WHERE id = ?").bind(docId).first<{ key: string; filename: string }>();
  const obj = row ? await env.FILES.get(row.key) : null;
  if (!row || !obj) throw new HttpError(404, "the NDA's file is missing from storage");
  return { bytes: await obj.arrayBuffer(), filename: row.filename };
}

type NdaRow = Omit<Nda, "flags"> & { flags: string; fields: string; leaseUntil: number };
const hydrate = (r: NdaRow): Nda => {
  const { fields: _f, leaseUntil: _l, ...rest } = r;
  return { ...rest, flags: parseJson<NdaFlag[]>(r.flags, []) };
};

export async function listNdas(env: Env, f: { listingId?: number } = {}): Promise<Nda[]> {
  const { results } = await (await db(env))
    .prepare(`SELECT n.*, l.title AS listingTitle FROM ndas n LEFT JOIN listings l ON l.id = n.listingId ${f.listingId ? "WHERE n.listingId = ?1" : ""} ORDER BY (n.status = 'to_sign') DESC, n.updatedAt DESC LIMIT 200`)
    .bind(...(f.listingId ? [f.listingId] : []))
    .all<NdaRow>();
  return results.map(hydrate);
}

async function getNda(env: Env, id: number): Promise<NdaRow> {
  const r = await (await db(env)).prepare("SELECT * FROM ndas WHERE id = ?").bind(id).first<NdaRow>();
  if (!r) throw new HttpError(404, "NDA not found");
  return r;
}

// ---------- preparing an NDA ----------

async function signer(env: Env): Promise<{ s: NdaSettings; name: string; email: string; company: string; phone: string }> {
  const [s, o] = await Promise.all([ndaSettings(env), outreachSettings(env)]);
  const name = s.legalName || o.myName;
  if (!name || !/^\S+@\S+\.\S+$/.test(o.myEmail)) throw new HttpError(409, "Set your name and reply-to email first (Outreach, Sender & limits): they are who signs");
  return { s, name, email: o.myEmail, company: o.myCompany, phone: o.myPhone };
}

async function contactOf(env: Env, l: Listing): Promise<Contact | null> {
  return l.contactId ? await (await db(env)).prepare("SELECT * FROM contacts WHERE id = ?").bind(l.contactId).first<Contact>() : null;
}

/** Whether the runner may sign this one without asking, under the current rule. */
const cleared = (rule: NdaSettings["autoSign"], kind: Nda["kind"], flags: NdaFlag[], placement: NdaPlacement) =>
  rule === "off" ? 0 : kind === "ours" ? 1 : rule === "clean" && placement === "anchored" && !flags.some((f) => f.level === "red") ? 1 : 0;

async function insert(env: Env, n: { listingId: number; contactId: number | null; kind: Nda["kind"]; title: string; counterparty: string | null; counterpartyEmail: string | null; sourceDocId: number; flags: NdaFlag[]; fields: NdaField[]; placement: NdaPlacement; auto: number }): Promise<number> {
  const now = Date.now();
  const r = await (await db(env))
    .prepare("INSERT INTO ndas (listingId, contactId, kind, status, title, counterparty, counterpartyEmail, sourceDocId, flags, fields, placement, auto, createdAt, updatedAt) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(n.listingId, n.contactId, n.kind, n.title, n.counterparty, n.counterpartyEmail, n.sourceDocId, JSON.stringify(n.flags), JSON.stringify(n.fields), n.placement, n.auto, now, now)
    .first<{ id: number }>();
  return r!.id;
}

/** Put a prepared NDA into Documenso. Kept apart from preparing so a failure here can simply be retried. */
export async function openNda(env: Env, id: number): Promise<Nda> {
  const d = await db(env);
  const n = await getNda(env, id);
  if (n.status === "signed") return hydrate(n);
  if (n.status === "to_sign" && n.envelopeId) return hydrate(n);
  try {
    const who = await signer(env);
    const { bytes, filename } = await docBytes(env, n.sourceDocId!);
    const { envelopeId, signingUrl } = await openEnvelope(env, { title: n.title, filename, bytes: new Uint8Array(bytes), signer: { name: who.name, email: who.email }, fields: parseJson<NdaField[]>(n.fields, []), externalId: `ma-hunter-nda-${id}` });
    await d.prepare("UPDATE ndas SET status = 'to_sign', envelopeId = ?, signingUrl = ?, error = NULL, attempts = 0, updatedAt = ? WHERE id = ?").bind(envelopeId, signingUrl, Date.now(), id).run();
  } catch (e) {
    await d.prepare("UPDATE ndas SET status = 'failed', error = ?, updatedAt = ? WHERE id = ?").bind((e as Error).message.slice(0, 400), Date.now(), id).run();
    throw e;
  }
  return hydrate(await getNda(env, id));
}

const live = (env: Env, listingId: number, kind: Nda["kind"]) =>
  db(env).then((d) => d.prepare("SELECT id FROM ndas WHERE listingId = ? AND kind = ? AND status IN ('to_sign', 'signed') LIMIT 1").bind(listingId, kind).first<{ id: number }>());

/** Our own confidentiality agreement for one listing. */
export async function createOurs(env: Env, listingId: number, actor: string): Promise<Nda> {
  const l = await getListing(env, listingId);
  if (await live(env, listingId, "ours")) throw new HttpError(409, "this listing already has your NDA");
  const who = await signer(env);
  const c = await contactOf(env, l);
  const business = `${l.title}${/^\d{4,}$/.test(l.sourceId) ? ` (${l.source} listing ${l.sourceId})` : ""}`;
  const counterparty = [c?.name, c?.company].filter(Boolean).join(", ");
  const { bytes, fields } = await buildNda({ template: who.s.template, buyer: who.company ? `${who.name}, ${who.company}` : who.name, buyerTitle: who.s.title, buyerAddress: who.s.address, buyerEmail: who.email, business, counterparty, termYears: who.s.termYears, state: who.s.state });
  const docId = await putDoc(env, listingId, `NDA - ${l.title.slice(0, 60)} - unsigned.pdf`, bytes, "other");
  const id = await insert(env, { listingId, contactId: l.contactId, kind: "ours", title: `NDA: ${l.title}`.slice(0, 200), counterparty: counterparty || null, counterpartyEmail: c?.email ?? null, sourceDocId: docId, flags: [], fields, placement: "generated", auto: cleared(who.s.autoSign, "ours", [], "generated") });
  await logEvent(env, { actor, listingId, type: "nda", message: "Your NDA was prepared for signing" });
  return openNda(env, id).catch(async () => hydrate(await getNda(env, id)));
}

/** A broker's or owner's NDA, as a PDF. Read it, flag it, find where the buyer signs. */
export async function createTheirs(env: Env, listingId: number, filename: string, bytes: ArrayBuffer, actor: string): Promise<Nda> {
  const l = await getListing(env, listingId);
  const head = new Uint8Array(bytes.slice(0, 5));
  if (String.fromCharCode(...head) !== "%PDF-") throw new HttpError(400, "that file isn't a PDF");
  if (bytes.byteLength > 15 * 1024 * 1024) throw new HttpError(413, "NDAs are limited to 15 MB");
  const who = await signer(env);
  const c = await contactOf(env, l);
  let flags: NdaFlag[];
  let fields: NdaField[];
  let placement: NdaPlacement;
  try {
    const read = await readPdf(bytes);
    flags = scanNda(read.text);
    ({ fields, placement } = placeFields(read, { name: who.name, title: who.s.title, company: who.company, email: who.email, phone: who.phone, address: who.s.address }));
  } catch (e) {
    throw new HttpError(422, `that PDF couldn't be read (${(e as Error).message.slice(0, 120)})`);
  }
  const docId = await putDoc(env, listingId, filename, bytes, "other");
  const id = await insert(env, { listingId, contactId: l.contactId, kind: "theirs", title: `NDA from ${c?.company || c?.name || l.source}: ${l.title}`.slice(0, 200), counterparty: [c?.name, c?.company].filter(Boolean).join(", ") || null, counterpartyEmail: c?.email ?? null, sourceDocId: docId, flags, fields, placement, auto: cleared(who.s.autoSign, "theirs", flags, placement) });
  const reds = flags.filter((f) => f.level === "red").length;
  await logEvent(env, { actor, listingId, type: "nda", message: `NDA received (${filename.slice(0, 60)})${reds ? `: ${reds} clause${reds === 1 ? "" : "s"} to read before signing` : flags.length ? ": nothing unusual, a few standard clauses noted" : ": nothing unusual found"}` });
  if (l.ndaStatus === "none") await (await db(env)).prepare("UPDATE listings SET ndaStatus = 'requested' WHERE id = ?").bind(listingId).run();
  return openNda(env, id).catch(async () => hydrate(await getNda(env, id)));
}

export async function setAuto(env: Env, id: number, auto: boolean): Promise<void> {
  await (await db(env)).prepare("UPDATE ndas SET auto = ?, attempts = 0, error = NULL, updatedAt = ? WHERE id = ? AND status = 'to_sign'").bind(auto ? 1 : 0, Date.now(), id).run();
}

export async function voidNda(env: Env, id: number, actor: string): Promise<void> {
  const n = await getNda(env, id);
  if (n.status === "signed") throw new HttpError(409, "a signed NDA can't be cancelled here");
  if (n.envelopeId && n.status === "to_sign") await dz(env, "POST", "/envelope/cancel", { envelopeId: n.envelopeId, reason: "Cancelled in M&A Hunter" }).catch(() => undefined);
  await (await db(env)).prepare("UPDATE ndas SET status = 'void', auto = 0, updatedAt = ? WHERE id = ?").bind(Date.now(), id).run();
  await logEvent(env, { actor, listingId: n.listingId, type: "nda", message: "NDA cancelled" });
}

// ---------- completion ----------

const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "there";

/** Queue the signed copy back to the broker, in the thread they wrote in, as an already-approved message. */
async function queueReturn(env: Env, n: NdaRow, signedDocId: number): Promise<boolean> {
  const s = await ndaSettings(env);
  if (!s.returnByEmail || !n.listingId) return false;
  const d = await db(env);
  const c = n.contactId ? await d.prepare("SELECT name, email, doNotContact FROM contacts WHERE id = ?").bind(n.contactId).first<{ name: string | null; email: string | null; doNotContact: number }>() : null;
  if (!c?.email || c.doNotContact) return false;
  const last = await d.prepare("SELECT subject, threadId FROM messages WHERE listingId = ? AND threadId IS NOT NULL ORDER BY COALESCE(sentAt, createdAt) DESC LIMIT 1").bind(n.listingId).first<{ subject: string; threadId: string }>();
  const l = await getListing(env, n.listingId);
  const o = await outreachSettings(env);
  const vars: Record<string, string> = { first_name: firstName(c.name), business: l.title, signature: o.signature || o.myName, my_name: o.myName };
  const body = s.returnMessage.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
  const subject = last?.subject ? (/^re:/i.test(last.subject) ? last.subject : `Re: ${last.subject}`) : `Signed NDA: ${l.title}`;
  const now = Date.now();
  await d
    .prepare("INSERT INTO messages (listingId, contactId, direction, channel, step, toEmail, subject, body, status, scheduledAt, threadId, attachDocId, createdAt) VALUES (?, ?, 'out', 'email', 0, ?, ?, ?, 'approved', ?, ?, ?, ?)")
    .bind(n.listingId, n.contactId, c.email, subject.slice(0, 200), body, now, last?.threadId ?? null, signedDocId, now)
    .run();
  return true;
}

/** Ask Documenso where one NDA stands; file the signed copy when it is complete. */
export async function syncNda(env: Env, id: number): Promise<Nda> {
  const d = await db(env);
  const n = await getNda(env, id);
  if (n.status !== "to_sign" || !n.envelopeId) return hydrate(n);
  const e = await dz<Envelope>(env, "GET", `/envelope/${encodeURIComponent(n.envelopeId)}`);
  const now = Date.now();
  if (e.status === "REJECTED" || e.status === "CANCELLED") {
    await d.prepare("UPDATE ndas SET status = 'void', auto = 0, updatedAt = ? WHERE id = ?").bind(now, id).run();
  } else if (e.status === "COMPLETED") {
    const item = [...e.envelopeItems].sort((a, b) => a.order - b.order)[0];
    const res = await fetch(`${env.DOCUMENSO_URL!.replace(/\/+$/, "")}/api/v2/envelope/item/${encodeURIComponent(item.id)}/download?version=signed`, { headers: { Authorization: env.DOCUMENSO_TOKEN! } });
    if (!res.ok) throw new HttpError(502, `Documenso answered ${res.status} for the signed PDF`);
    const bytes = await res.arrayBuffer();
    let signedDocId: number | null = null;
    if (n.listingId) {
      const l = await getListing(env, n.listingId);
      signedDocId = await putDoc(env, n.listingId, `NDA - ${l.title.slice(0, 60)} - signed.pdf`, bytes, "nda");
      await d
        .prepare("UPDATE listings SET ndaStatus = 'signed', stageAt = CASE WHEN stage IN ('new', 'shortlist', 'contacted', 'conversation') THEN ?1 ELSE stageAt END, stage = CASE WHEN stage IN ('new', 'shortlist', 'contacted', 'conversation') THEN 'nda' ELSE stage END, updatedAt = ?1 WHERE id = ?2")
        .bind(now, n.listingId)
        .run();
    }
    // The claim on the row makes this idempotent: two syncs racing file one signed copy and one email.
    const won = await d.prepare("UPDATE ndas SET status = 'signed', signedDocId = ?, signedAt = ?, auto = 0, error = NULL, updatedAt = ? WHERE id = ? AND status = 'to_sign'").bind(signedDocId, now, now, id).run();
    if (won.meta.changes === 1) {
      const queued = signedDocId ? await queueReturn(env, n, signedDocId) : false;
      await logEvent(env, { actor: "documenso", listingId: n.listingId, type: "nda", message: `NDA signed${queued ? "; the signed copy is queued back to the broker" : ""}` });
    }
  }
  return hydrate(await getNda(env, id));
}

/** Cron: check every NDA that is out for signature. */
export async function syncNdas(env: Env): Promise<{ checked: number; signed: number }> {
  if (!documensoConfigured(env)) return { checked: 0, signed: 0 };
  const { results } = await (await db(env)).prepare("SELECT id FROM ndas WHERE status = 'to_sign' AND envelopeId IS NOT NULL ORDER BY updatedAt ASC LIMIT 25").all<{ id: number }>();
  let signed = 0;
  for (const r of results) {
    try {
      if ((await syncNda(env, r.id)).status === "signed") signed++;
    } catch (e) {
      console.error(`nda ${r.id}: ${(e as Error).message}`);
    }
  }
  return { checked: results.length, signed };
}

// ---------- the browser runner ----------

export interface SignTask {
  kind: "sign";
  ndaId: number;
  url: string;
  title: string;
  signerName: string;
  /** Where the signature goes, as percentages of each page: Documenso draws fields on a canvas, so the runner clicks by position. */
  fields: NdaField[];
}

/** Hand the runner one NDA that the auto-sign rule cleared, leased for ten minutes. Three tries, then it waits for a person. */
export async function claimSignTask(env: Env): Promise<SignTask | null> {
  if (!documensoConfigured(env)) return null;
  const d = await db(env);
  const now = Date.now();
  const { results } = await d.prepare("SELECT id, signingUrl, title, fields FROM ndas WHERE status = 'to_sign' AND auto = 1 AND signingUrl IS NOT NULL AND leaseUntil < ? AND attempts < 3 ORDER BY createdAt ASC LIMIT 3").bind(now).all<{ id: number; signingUrl: string; title: string; fields: string }>();
  for (const n of results) {
    const won = await d.prepare("UPDATE ndas SET leaseUntil = ?, attempts = attempts + 1 WHERE id = ? AND leaseUntil < ? AND status = 'to_sign' AND auto = 1").bind(now + 10 * 60_000, n.id, now).run();
    if (won.meta.changes === 1) return { kind: "sign", ndaId: n.id, url: n.signingUrl, title: n.title, signerName: (await signer(env)).name, fields: parseJson<NdaField[]>(n.fields, []).filter((f) => f.type === "SIGNATURE") };
  }
  return null;
}

/** The runner's word is not taken for it: "signed" only triggers a check with Documenso. */
export async function reportSign(env: Env, agent: string, r: { ndaId: number; outcome: "signed" | "needs_human" | "failed"; detail?: string }): Promise<{ status: string }> {
  const d = await db(env);
  const n = await getNda(env, Number(r.ndaId));
  if (r.outcome === "signed") {
    await d.prepare("UPDATE ndas SET leaseUntil = 0 WHERE id = ?").bind(n.id).run();
    return { status: (await syncNda(env, n.id)).status };
  }
  const detail = (r.detail ?? "the runner could not finish").slice(0, 300);
  await d.prepare("UPDATE ndas SET leaseUntil = 0, error = ?, auto = CASE WHEN ?2 = 'needs_human' OR attempts >= 3 THEN 0 ELSE auto END, updatedAt = ? WHERE id = ?").bind(detail, r.outcome, Date.now(), n.id).run();
  await logEvent(env, { actor: agent, listingId: n.listingId, type: "needs_human", message: `NDA signing: ${detail}` });
  return { status: "to_sign" };
}

// ---------- replies ----------

export interface MailAttachment {
  name: string;
  type?: string;
  /** base64 */
  data: string;
}

const b64 = (s: string): ArrayBuffer => Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;

/**
 * A broker's reply arrived. If it carries an NDA as a PDF, prepare that one for signing. If it asks for
 * an NDA and carries none, send ours (when that is switched on). Never throws: a reply must be filed
 * even if its attachment can't be read.
 */
export async function onReply(env: Env, a: { listingId: number | null; classification: string | null; attachments?: MailAttachment[] }): Promise<"theirs" | "ours" | null> {
  if (!a.listingId) return null;
  try {
    const pdfs = (a.attachments ?? []).filter((f) => /\.pdf$/i.test(f.name ?? "") || f.type === "application/pdf");
    const nda = pdfs.find((f) => /nda|non[-_ ]?disclos|confidential|\bca\b/i.test(f.name)) ?? (a.classification === "nda" ? pdfs[0] : undefined);
    if (nda) {
      if (await live(env, a.listingId, "theirs")) return null;
      await createTheirs(env, a.listingId, nda.name, b64(nda.data), "gmail");
      return "theirs";
    }
    if (a.classification === "nda" && (await ndaSettings(env)).onRequest === "send_mine") {
      if ((await live(env, a.listingId, "ours")) || (await live(env, a.listingId, "theirs"))) return null;
      await createOurs(env, a.listingId, "gmail");
      return "ours";
    }
  } catch (e) {
    await logEvent(env, { actor: "hub", listingId: a.listingId, type: "needs_human", message: `NDA could not be prepared: ${(e as Error).message.slice(0, 200)}` });
  }
  return null;
}

/** The Gmail bridge fetches a message's attachment here, with its own token. */
export async function attachment(env: Env, docId: number): Promise<Response> {
  const d = await db(env);
  // Only documents that a queued or sent message actually carries can leave this way.
  const used = await d.prepare("SELECT 1 AS x FROM messages WHERE attachDocId = ? AND direction = 'out' LIMIT 1").bind(docId).first();
  if (!used) throw new HttpError(404, "no message carries that document");
  const { bytes, filename } = await docBytes(env, docId);
  return new Response(bytes, { headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(filename), "Cache-Control": "no-store" } });
}
