#!/usr/bin/env node
/**
 * End-to-end check of the runner against a local hub and a fake marketplace.
 *
 * Needs the hub running locally in demo mode (`npm run demo` in the repo root) with an agent token in
 * .dev.vars. It serves a few fake listing pages, adds a browser search for them, runs the runner's
 * sourcing over it, then pushes one inquiry through the fake contact form and checks the hub saw it all.
 *
 *   node selftest.mjs [hubUrl]
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hubClient, openBrowser, runContact, runSource } from "./runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = (process.argv[2] ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
const vars = readFileSync(join(HERE, "..", ".dev.vars"), "utf8");
const token = Object.values(JSON.parse(vars.match(/^AGENT_TOKENS=(.*)$/m)[1]))[0];

const LISTINGS = [
  { id: "9100001", slug: "hvac-service-company", title: "HVAC Service Company with Maintenance Contracts", price: "$1,250,000", cash: "$410,000", extra: "Financing:\nSeller financing available with 25% down.\nReason for Selling:\nRetirement\nSupport & Training:\nSeller will stay for 90 days of training." },
  { id: "9100002", slug: "commercial-cleaning-route", title: "Commercial Cleaning Route, Absentee Owner", price: "$380,000", cash: "$140,000", extra: "Absentee owner with a manager in place.\nReason for Selling:\nRelocation" },
  { id: "9100003", slug: "sign-shop", title: "Sign and Graphics Shop", price: "$520,000", cash: "$165,000", extra: "Owner-operator. Cash buyers only." },
];
let submitted = null;

const page = (title, body) => `<!doctype html><html><head><title>${title} | FakeBizMarket</title></head><body>${body}</body></html>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const html = (s) => (res.writeHead(200, { "Content-Type": "text/html" }), res.end(s));
  if (url.pathname === "/businesses-for-sale/") {
    return html(page("Businesses for sale", `<h1>Businesses for sale</h1><a href="/about/">About</a>${LISTINGS.map((l) => `<div class="card"><a href="/business-opportunity/${l.slug}/${l.id}/"><h3>${l.title}</h3></a><p>Asking Price: ${l.price}</p></div>`).join("")}<a href="/businesses-for-sale/page/2/">Next</a>`));
  }
  const l = LISTINGS.find((x) => url.pathname === `/business-opportunity/${x.slug}/${x.id}/`);
  if (l && req.method === "POST") {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      submitted = Object.fromEntries(new URLSearchParams(data));
      html(page("Sent", "<h1>Thank you</h1><p>Your message has been sent to the broker.</p>"));
    });
    return;
  }
  if (l) {
    return html(
      page(
        l.title,
        `<h1>${l.title}</h1><p>Columbus, OH</p><dl><dt>Asking Price:</dt><dd>${l.price}</dd><dt>Cash Flow:</dt><dd>${l.cash}</dd><dt>Established:</dt><dd>2009</dd></dl>
         <pre>${l.extra}</pre><p>Business Listed By:</p><p>Jordan Reyes</p>
         <form method="post"><label>Your name <input name="fullname" required></label><label>Email <input type="email" name="email" required></label>
         <label>Phone <input type="tel" name="phone"></label><label>Message <textarea name="message" required></textarea></label><button type="submit">Contact seller</button></form>`,
      ),
    );
  }
  res.writeHead(404);
  res.end("not found");
});

const admin = async (method, path, body) => {
  const res = await fetch(`${HUB}/api/admin${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
};
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) process.exitCode = 1;
};

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const profileDir = mkdtempSync(join(tmpdir(), "mah-selftest-"));
const cfg = { hubUrl: HUB, token, profileDir, channel: "chrome", headless: true, submitForms: true, maxDetailPages: 10, pauseSeconds: [0.2, 0.5], capabilities: ["source", "contact"] };
const hub = hubClient(cfg);
let context;
try {
  // Send at any hour, and hold everything already queued so the only contact task is ours.
  await admin("PUT", "/settings/outreach", { windowStart: 0, windowEnd: 24, weekdaysOnly: false, paused: false, myName: "Alex Morgan", myEmail: "alex@example.com", myPhone: "(555) 010-0199" });
  for (const m of await admin("GET", "/messages?status=approved")) if (m.channel === "form") await admin("PATCH", `/messages/${m.id}`, { status: "draft" });

  const { id: searchId } = await admin("POST", "/searches", { source: "browser", name: `Selftest ${Date.now()}`, query: `${base}/businesses-for-sale/`, everyHours: 1 });
  context = await openBrowser(cfg);

  await runSource(context, cfg, hub, { kind: "source", searchId, name: "selftest", url: `${base}/businesses-for-sale/` });
  const found = (await admin("GET", `/listings?q=${encodeURIComponent("91000")}&limit=10`)).items.filter((l) => l.sourceId.startsWith("91000"));
  check(found.length === 3, `sourcing: 3 fake listings reached the hub (got ${found.length})`);
  const hvac = found.find((l) => l.sourceId === "9100001");
  check(hvac?.askingPrice === 1_250_000 && hvac?.cashFlow === 410_000, `parsing: price and cash flow read (${hvac?.askingPrice}, ${hvac?.cashFlow})`);
  check(hvac?.sellerFinancing === "yes" && hvac?.reasonForSelling === "Retirement" && hvac?.ownerStays !== "unknown", `signals: financing=${hvac?.sellerFinancing}, reason=${hvac?.reasonForSelling}, owner stays=${hvac?.ownerStays}`);
  check(found.find((l) => l.sourceId === "9100003")?.sellerFinancing === "no", "signals: 'cash buyers only' read as no seller financing");
  const search = (await admin("GET", "/searches")).find((s) => s.id === searchId);
  check(search?.lastCount === 3 && search?.lastNew === 3 && !search?.lastError, `search run recorded (seen ${search?.lastCount}, new ${search?.lastNew})`);

  const formSeq = (await admin("GET", "/sequences")).find((s) => s.channel === "form");
  const detail = await admin("POST", `/listings/${hvac.id}/enroll`, { sequenceId: formSeq.id });
  const draft = detail.messages.find((m) => m.status === "draft");
  await admin("PATCH", `/messages/${draft.id}`, { status: "approved" });
  // Anything else still queued from earlier (a lease that ran out) is set aside so our message comes up.
  let task = null;
  for (let i = 0; i < 6; i++) {
    ({ task } = await hub("/work", { capabilities: ["contact"] }));
    if (!task || task.messageId === draft.id) break;
    await hub("/contact-result", { messageId: task.messageId, outcome: "needs_human", detail: "Set aside by the runner self-test" });
  }
  check(task?.kind === "contact" && task.messageId === draft.id, "contact: the approved form message was handed to the runner");
  await runContact(context, cfg, hub, task);
  // Browsers post textarea line breaks as CRLF.
  check(submitted?.message?.replace(/\r\n/g, "\n") === draft.body &&submitted?.email === "alex@example.com" && submitted?.fullname === "Alex Morgan", `contact: the form received the message, name and email (${submitted ? "submitted" : "nothing submitted"})`);
  const after = await admin("GET", `/listings/${hvac.id}`);
  check(after.messages.find((m) => m.id === draft.id)?.status === "sent" && after.listing.stage === "contacted" && after.listing.contactCount === 1, `hub: message marked sent, listing moved to "${after.listing.stage}"`);

  await admin("DELETE", `/searches/${searchId}`);
  for (const l of found) await admin("DELETE", `/listings/${l.id}`);
} finally {
  await context?.close().catch(() => {});
  server.close();
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 });
}
console.log(process.exitCode ? "\nSelf-test FAILED" : "\nSelf-test passed");
