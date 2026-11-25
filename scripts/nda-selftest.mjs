// End-to-end check of NDA signing, against the local hub and a stand-in for Documenso.
//
//   1. start the stand-in:   node scripts/nda-selftest.mjs --serve        (listens on 127.0.0.1:8799)
//   2. start the hub:        npm run build && node ./node_modules/wrangler/bin/wrangler.js dev --port 8788 --local-upstream 127.0.0.1:8788 \
//                              --var MOCK:true --var DOCUMENSO_URL:http://127.0.0.1:8799 --var DOCUMENSO_TOKEN:api_selftest_0123456789
//   3. run the checks:       node scripts/nda-selftest.mjs
//
// The stand-in implements the four Documenso v2 calls the hub makes, with the request shapes from Documenso's
// published API description, and refuses anything shaped differently. "Signing" is a call to its /sign/<token>.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HUB = process.env.MAH_HUB_URL ?? "http://127.0.0.1:8788";
const FAKE = "http://127.0.0.1:8799";
const TOKEN = "api_selftest_0123456789";

// ---------- the stand-in Documenso ----------

function serve() {
  const envelopes = new Map(); // id -> { status, payload, pdf, token }
  let n = 0;
  const send = (res, code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  createServer(async (req, res) => {
    const url = new URL(req.url, FAKE);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    try {
      // The signing page: a person (or the runner) signs here. No API token, as in Documenso.
      if (url.pathname.startsWith("/sign/")) {
        const e = [...envelopes.values()].find((x) => x.token === url.pathname.slice(6));
        if (!e) return send(res, 404, { message: "unknown signing link" });
        if (e.status === "PENDING") e.status = "COMPLETED";
        return send(res, 200, "<h1>Signed</h1>", "text/html");
      }
      if (req.headers.authorization !== TOKEN) return send(res, 401, { message: "bad API token" });
      const path = url.pathname.replace(/^\/api\/v2/, "");

      if (path === "/envelope/create" && req.method === "POST") {
        // multipart/form-data with a JSON string field "payload" and one or more "files".
        const form = await new Request(FAKE, { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: raw }).formData();
        const payload = JSON.parse(String(form.get("payload")));
        const file = form.get("files");
        const problems = [];
        if (!payload.title || payload.type !== "DOCUMENT") problems.push("title and type DOCUMENT are required");
        if (!(file instanceof File) || Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString() !== "%PDF-") problems.push("files must be a PDF");
        const r = payload.recipients?.[0];
        if (!r?.email || !r?.name || r.role !== "SIGNER") problems.push("one SIGNER recipient with name and email is required");
        for (const f of r?.fields ?? []) {
          if (!["SIGNATURE", "DATE", "TEXT"].includes(f.type)) problems.push(`unexpected field type ${f.type}`);
          for (const k of ["page", "positionX", "positionY", "width", "height"]) if (typeof f[k] !== "number") problems.push(`field ${f.type}: ${k} must be a number`);
          if (f.positionX < 0 || f.positionX + f.width > 100.01 || f.positionY < 0 || f.positionY + f.height > 100.01) problems.push(`field ${f.type} is off the page`);
          if (f.type === "TEXT" && (f.fieldMeta?.type !== "text" || typeof f.fieldMeta.text !== "string")) problems.push("TEXT fields need fieldMeta { type: 'text', text }");
        }
        if (!(r?.fields ?? []).some((f) => f.type === "SIGNATURE")) problems.push("no SIGNATURE field");
        if (problems.length) return send(res, 400, { message: problems.join("; ") });
        const id = `envelope_test${++n}`;
        envelopes.set(id, { status: "DRAFT", payload, pdf: Buffer.from(await file.arrayBuffer()), token: `tok${n}${Math.random().toString(36).slice(2, 10)}` });
        return send(res, 200, { id });
      }
      const json = raw.length ? JSON.parse(raw.toString()) : {};
      if (path === "/envelope/distribute" && req.method === "POST") {
        const e = envelopes.get(json.envelopeId);
        if (!e) return send(res, 404, { message: "no such envelope" });
        if (json.meta?.distributionMethod !== "NONE") return send(res, 400, { message: "the hub must not have Documenso email anyone" });
        e.status = "PENDING";
        const r = e.payload.recipients[0];
        return send(res, 200, { success: true, id: json.envelopeId, recipients: [{ id: 1, name: r.name, email: r.email, token: e.token, role: "SIGNER", signingOrder: 1, signingUrl: `${FAKE}/sign/${e.token}` }] });
      }
      if (path === "/envelope/cancel" && req.method === "POST") {
        const e = envelopes.get(json.envelopeId);
        if (e) e.status = "CANCELLED";
        return send(res, 200, { success: true });
      }
      const get = /^\/envelope\/(envelope_test\d+)$/.exec(path);
      if (get && req.method === "GET") {
        const e = envelopes.get(get[1]);
        if (!e) return send(res, 404, { message: "no such envelope" });
        return send(res, 200, { id: get[1], status: e.status, recipients: [{ ...e.payload.recipients[0], signingStatus: e.status === "COMPLETED" ? "SIGNED" : "NOT_SIGNED", token: e.token }], envelopeItems: [{ id: `item_${get[1]}`, order: 1 }], fields: e.payload.recipients[0].fields });
      }
      const dl = /^\/envelope\/item\/item_(envelope_test\d+)\/download$/.exec(path);
      if (dl && req.method === "GET") {
        const e = envelopes.get(dl[1]);
        if (!e || e.status !== "COMPLETED" || url.searchParams.get("version") !== "signed") return send(res, 400, { message: "not completed" });
        return send(res, 200, e.pdf, "application/pdf");
      }
      send(res, 404, { message: `the stand-in has no ${req.method} ${path}` });
    } catch (e) {
      send(res, 500, { message: String(e?.message ?? e) });
    }
  }).listen(8799, "127.0.0.1", () => console.log(`stand-in Documenso on ${FAKE}`));
}

if (process.argv.includes("--serve")) {
  serve();
} else {
  await checks();
}

// ---------- the checks ----------

async function checks() {
  const vars = Object.fromEntries(readFileSync(join(root, ".dev.vars"), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
  const agentToken = Object.values(JSON.parse(vars.AGENT_TOKENS))[0];
  const call = async (auth, method, path, body, raw) => {
    const res = await fetch(HUB + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(raw ? { "Content-Type": "application/pdf" } : body ? { "Content-Type": "application/json" } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
  const admin = (m, p, b, raw) => call(null, m, `/api/admin${p}`, b, raw);
  const agent = (m, p, b) => call(agentToken, m, `/api/agent${p}`, b);
  const gmail = (p, b) => call(vars.GMAIL_BRIDGE_TOKEN, "POST", `/api/gmail${p}`, b);

  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
    if (!ok) failed++;
  };
  const brokerNda = async (lines) => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    lines.forEach((t, i) => page.drawText(t, { x: 72, y: 730 - i * 18, size: 10, font }));
    page.drawText("Buyer Signature: ______________________________", { x: 72, y: 300, size: 10, font });
    page.drawText("Print Name: ______________________________", { x: 72, y: 270, size: 10, font });
    page.drawText("Date: ______________", { x: 72, y: 240, size: 10, font });
    return Buffer.from(await pdf.save());
  };
  const stamp = Date.now();
  const newListing = async (title, email) => (await admin("POST", "/listings", { title, source: "selftest", sourceId: `${stamp}-${title.length}-${Math.random().toString(36).slice(2, 7)}`, askingPrice: 500000, cashFlow: 150000, contactName: "Jordan Reyes", contactEmail: email, contactCompany: "Coastal Business Brokers" })).body.listing.id;

  const status = (await admin("GET", "/status")).body;
  check("the hub sees Documenso as connected", status.configured?.documenso === true, JSON.stringify(status.configured));
  await admin("PUT", "/settings/outreach", { myName: "Avery Stone", myCompany: "Northwind Holdings LLC", myEmail: "avery@northwind.example", myPhone: "555-0100", signature: "Avery Stone\nNorthwind Holdings LLC", paused: false, windowStart: 0, windowEnd: 24, weekdaysOnly: false });
  await admin("PUT", "/settings/nda", { title: "Managing Member", state: "the State of Texas", autoSign: "clean", onRequest: "send_mine", returnByEmail: true });

  // NDAs left waiting by an earlier run would be handed to the "runner" first: take them out of its queue (they stay signable by hand).
  for (const old of (await admin("GET", "/ndas")).body.items.filter((n) => n.status === "to_sign" && n.auto)) await admin("POST", `/ndas/${old.id}/auto`, { auto: false });

  // --- ours ---
  const a = await newListing(`Selftest SaaS ${stamp}`, `jordan+${stamp}@coastal.example`);
  const ours = (await admin("POST", `/listings/${a}/nda`)).body;
  check("our NDA becomes a Documenso envelope with a signing link", ours.status === "to_sign" && /\/sign\//.test(ours.signingUrl ?? ""), JSON.stringify(ours).slice(0, 300));
  check("our NDA is cleared for the runner under the auto-sign rule", ours.auto === 1);
  check("a second NDA of ours for the same listing is refused", (await admin("POST", `/listings/${a}/nda`)).status === 409);
  const unsigned = await admin("GET", `/documents/${ours.sourceDocId}`);
  check("the unsigned PDF is in the listing's documents", unsigned.status === 200 && unsigned.body.subarray(0, 5).toString() === "%PDF-");
  check("an unsigned NDA does not mark the listing as signed", (await admin("GET", `/listings/${a}`)).body.listing.ndaStatus !== "signed");

  // The runner takes it, "signs", and reports. The hub believes Documenso, not the runner.
  const task = (await agent("POST", "/work", { capabilities: ["sign"] })).body.task;
  check("the runner is handed the signing task", task?.kind === "sign" && task.ndaId === ours.id && task.signerName === "Avery Stone", JSON.stringify(task));
  const early = (await agent("POST", "/sign-result", { ndaId: ours.id, outcome: "signed" })).body;
  check("a runner claiming 'signed' before Documenso agrees changes nothing", early.status === "to_sign", JSON.stringify(early));
  await fetch(task.url);
  const done = (await agent("POST", "/sign-result", { ndaId: ours.id, outcome: "signed" })).body;
  check("once Documenso says completed, the NDA is signed", done.status === "signed", JSON.stringify(done));
  const after = (await admin("GET", `/listings/${a}`)).body;
  check("the listing moved to 'NDA signed'", after.listing.ndaStatus === "signed" && after.listing.stage === "nda", `${after.listing.ndaStatus} / ${after.listing.stage}`);
  check("the signed PDF is filed as an NDA document", after.documents.some((d) => d.kind === "nda" && /signed\.pdf$/.test(d.filename)));
  const back = after.messages.find((m) => m.direction === "out" && /signed NDA/i.test(m.body));
  check("the signed copy is queued back to the broker, already approved", back?.status === "approved" && back.toEmail === `jordan+${stamp}@coastal.example`, JSON.stringify(back ?? null).slice(0, 200));
  const work = (await gmail("/work", { account: "avery@northwind.example" })).body;
  const out = (work.send ?? []).find((m) => m.id === back?.id);
  check("the Gmail bridge is given the message with its attachment", out?.attachments?.length === 1 && /signed\.pdf$/.test(out.attachments[0].filename), JSON.stringify(work.send ?? work.reason).slice(0, 300));
  const att = out ? await gmail("/attachment", { id: out.attachments[0].id }) : { status: 0, body: Buffer.alloc(0) };
  check("the bridge can fetch that attachment", att.status === 200 && att.body.subarray(0, 5).toString() === "%PDF-");
  check("the bridge cannot fetch a document no message carries", (await gmail("/attachment", { id: ours.sourceDocId })).status === 404);
  if (out) await gmail("/report", { account: "avery@northwind.example", sent: [{ id: out.id, ok: true, gmailId: `g-${stamp}`, threadId: `t-${stamp}` }] });
  check("a second check with Documenso files nothing twice", (await admin("POST", `/ndas/${ours.id}/sync`)).body.status === "signed" && (await admin("GET", `/listings/${a}`)).body.documents.filter((d) => d.kind === "nda").length === 1);

  // --- theirs, uploaded ---
  const b = await newListing(`Selftest Distribution ${stamp}`, `sam+${stamp}@brokers.example`);
  const plain = await brokerNda(["NON-DISCLOSURE AGREEMENT", "The undersigned prospective buyer agrees to keep all information confidential and to use it", "only to evaluate a purchase of the business. These obligations continue for a period of two (2) years."]);
  const theirs = (await admin("POST", `/listings/${b}/nda/upload?filename=Broker%20NDA.pdf`, null, plain)).body;
  check("a plain broker NDA: signature line found, nothing red, cleared for the runner", theirs.status === "to_sign" && theirs.placement === "anchored" && !theirs.flags.some((f) => f.level === "red") && theirs.auto === 1, JSON.stringify(theirs).slice(0, 400));
  check("a file that isn't a PDF is refused", (await admin("POST", `/listings/${b}/nda/upload?filename=x.pdf`, null, Buffer.from("hello"))).status === 400);

  const c = await newListing(`Selftest Agency ${stamp}`, `lee+${stamp}@brokers.example`);
  const harsh = await brokerNda(["BUYER CONFIDENTIALITY AND FEE AGREEMENT", "If Buyer purchases the business other than through Broker, Buyer shall pay Broker a commission equal to", "ten percent of the purchase price. Buyer agrees to indemnify and hold Broker harmless from any claim.", "These obligations survive indefinitely."]);
  const risky = (await admin("POST", `/listings/${c}/nda/upload?filename=Fee%20Agreement.pdf`, null, harsh)).body;
  const reds = (risky.flags ?? []).filter((f) => f.level === "red").map((f) => f.label);
  check("a fee-and-indemnity NDA is flagged red and is NOT cleared for the runner", risky.status === "to_sign" && risky.auto === 0 && reds.some((l) => /fee or commission/.test(l)) && reds.includes("Indemnity"), JSON.stringify({ auto: risky.auto, reds }));
  const none = (await agent("POST", "/work", { capabilities: ["sign"] })).body.task;
  check("the runner is offered the clean one, never the flagged one", none?.ndaId === theirs.id, JSON.stringify(none));
  await admin("POST", `/ndas/${risky.id}/void`);
  check("a cancelled NDA leaves the queue", (await admin("GET", `/ndas?listingId=${c}`)).body.items[0].status === "void");

  // --- theirs, attached to a broker's reply ---
  const d = await newListing(`Selftest Logistics ${stamp}`, `pat+${stamp}@brokers.example`);
  const seq = (await admin("GET", "/sequences")).body.find((s) => s.target === "listing" && s.channel === "email");
  await admin("POST", `/listings/${d}/enroll`, { sequenceId: seq.id });
  const first = (await admin("GET", `/listings/${d}`)).body.messages.find((m) => m.direction === "out");
  await admin("POST", "/messages/approve", { ids: [first.id] });
  await gmail("/report", { account: "avery@northwind.example", sent: [{ id: first.id, ok: true, gmailId: `g1-${stamp}`, threadId: `thread-${stamp}` }] });
  const rep = (await gmail("/report", { account: "avery@northwind.example", inbound: [{ id: `in-${stamp}`, threadId: `thread-${stamp}`, from: `Pat Lee <pat+${stamp}@brokers.example>`, subject: "Re: your inquiry", text: "Thanks for reaching out. Please sign the attached NDA and I'll send the CIM.", kind: "reply", attachments: [{ name: "NDA - Coastal.pdf", type: "application/pdf", data: plain.toString("base64") }] }] })).body;
  const fromMail = (await admin("GET", `/ndas?listingId=${d}`)).body.items;
  check("a PDF on a broker's reply becomes an NDA to sign", rep.ndas === 1 && fromMail.length === 1 && fromMail[0].kind === "theirs" && fromMail[0].status === "to_sign", JSON.stringify({ rep, n: fromMail.length }));

  // --- a broker asks for an NDA and attaches none ---
  const e = await newListing(`Selftest Software ${stamp}`, `kim+${stamp}@brokers.example`);
  await admin("POST", `/listings/${e}/enroll`, { sequenceId: seq.id });
  const m2 = (await admin("GET", `/listings/${e}`)).body.messages.find((m) => m.direction === "out");
  await admin("POST", "/messages/approve", { ids: [m2.id] });
  await gmail("/report", { account: "avery@northwind.example", sent: [{ id: m2.id, ok: true, gmailId: `g2-${stamp}`, threadId: `thread2-${stamp}` }] });
  await gmail("/report", { account: "avery@northwind.example", inbound: [{ id: `in2-${stamp}`, threadId: `thread2-${stamp}`, from: `Kim Roe <kim+${stamp}@brokers.example>`, subject: "Re: your inquiry", text: "Happy to share more once we have a signed NDA in place.", kind: "reply" }] });
  const asked = (await admin("GET", `/ndas?listingId=${e}`)).body.items;
  check("a broker asking for an NDA with none attached gets ours prepared", asked.length === 1 && asked[0].kind === "ours" && asked[0].status === "to_sign", JSON.stringify(asked).slice(0, 200));

  console.log(failed ? `\n${failed} check(s) failed` : "\nAll NDA checks passed");
  process.exit(failed ? 1 : 0);
}
