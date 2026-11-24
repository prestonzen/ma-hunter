#!/usr/bin/env node
/**
 * M&A Hunter browser runner.
 *
 * The big marketplaces (BizBuySell, BizQuest, Flippa, LoopNet ...) refuse requests from servers, and most
 * listings can only be answered through a contact form. This program drives a real Chrome on a machine of
 * yours, with a profile you have signed in to by hand, and does two jobs for the hub:
 *
 *   source   open a saved "browser search", find the listings on it that the hub hasn't seen, open each
 *            one and send the page text to the hub, which parses and scores it.
 *   contact  open a listing and type an inquiry you approved in the hub into its contact form.
 *
 * What it deliberately does not do: store or type passwords (you sign in yourself with --login), solve
 * CAPTCHAs or get around a block (it stops and marks the task "needs you"), or hurry (one page every few
 * seconds, like a person reading).
 *
 *   node runner.mjs --login https://www.bizbuysell.com    sign in once per site, then close the window
 *   node runner.mjs                                       work until stopped
 *   node runner.mjs --once                                do one task and exit
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = "0.1.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (a, b) => a + Math.random() * (b - a);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function loadConfig(path = join(HERE, "config.json")) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
  const c = {
    hubUrl: process.env.MAH_HUB_URL ?? file.hubUrl ?? "",
    token: process.env.MAH_TOKEN ?? file.token ?? "",
    profileDir: resolve(HERE, file.profileDir ?? "profile"),
    channel: file.channel ?? "chrome", // the Chrome installed on this machine; "msedge" also works
    headless: file.headless ?? false,
    capabilities: file.capabilities ?? ["source", "contact"],
    submitForms: file.submitForms ?? false,
    maxDetailPages: file.maxDetailPages ?? 20,
    pauseSeconds: file.pauseSeconds ?? [5, 12],
    pollSeconds: file.pollSeconds ?? 90,
  };
  c.hubUrl = c.hubUrl.replace(/\/+$/, "");
  return c;
}

export function hubClient(cfg) {
  return async function hub(path, body) {
    const res = await fetch(`${cfg.hubUrl}/api/agent${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`hub ${res.status}: ${data.error ?? res.statusText}`);
    return data;
  };
}

export async function openBrowser(cfg) {
  const { chromium } = await import("playwright-core");
  return chromium.launchPersistentContext(cfg.profileDir, {
    channel: cfg.channel,
    headless: cfg.headless,
    viewport: null,
    args: ["--start-maximized"],
  });
}

/** What a page looks like when the site wants a person: a block page, a bot check, a sign-in wall. */
async function obstacle(page) {
  const title = (await page.title().catch(() => "")).toLowerCase();
  if (/access denied|just a moment|attention required|are you a robot|verify you are human|pardon our interruption/.test(title)) return `the site showed "${title}"`;
  const challenge = await page
    .locator('iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com/captcha"], iframe[src*="challenges.cloudflare.com"], #px-captcha')
    .first()
    .isVisible()
    .catch(() => false);
  return challenge ? "the site is showing a CAPTCHA" : null;
}

/** The same payload the browser clipper sends: visible text, JSON-LD, meta tags, contact links. */
export async function readPage(page) {
  return page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const jsonld = q('script[type="application/ld+json"]')
      .map((s) => {
        try {
          return JSON.parse(s.textContent);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const meta = {};
    for (const m of q("meta[name],meta[property]")) {
      const k = (m.getAttribute("property") || m.getAttribute("name") || "").toLowerCase();
      if (k && m.content) meta[k] = m.content;
    }
    return {
      url: location.href.split("#")[0],
      title: document.title,
      text: (document.body.innerText || "").slice(0, 200000),
      jsonld,
      meta,
      emails: q('a[href^="mailto:"]').map((a) => decodeURIComponent(a.href.slice(7).split("?")[0])),
      phones: q('a[href^="tel:"]').map((a) => a.href.slice(4)),
    };
  });
}

export async function runSource(context, cfg, hub, task) {
  const page = await context.newPage();
  const pages = [];
  let seen = 0;
  try {
    log(`source: ${task.name}`);
    await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(between(2500, 5000));
    const blocked = await obstacle(page);
    if (blocked) throw new Error(`${blocked}. Open the runner's browser (node runner.mjs --login ${new URL(task.url).origin}), get past it by hand, and the next run will go through.`);
    // Let lazy lists render.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 900) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 250));
      }
      window.scrollTo(0, 0);
    });

    const { links, unseen } = await hub("/links", { url: page.url(), html: await page.content() });
    seen = links.length;
    log(`  ${links.length} listings on the page, ${unseen.length} new`);
    for (const url of unseen.slice(0, cfg.maxDetailPages)) {
      await sleep(between(cfg.pauseSeconds[0], cfg.pauseSeconds[1]) * 1000);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await sleep(between(1500, 3500));
        const stop = await obstacle(page);
        if (stop) throw new Error(stop);
        pages.push(await readPage(page));
        log(`  read ${url}`);
      } catch (e) {
        log(`  skipped ${url}: ${e.message}`);
        if (/CAPTCHA|showed/.test(e.message)) break; // don't keep knocking
      }
      // Send in small batches so a crash loses little.
      if (pages.length >= 8) await hub("/pages", { searchId: task.searchId, pages: pages.splice(0) });
    }
    const r = await hub("/pages", { searchId: task.searchId, pages, seen, done: true });
    log(`  done: ${r.created} new, ${r.updated} updated`);
  } catch (e) {
    log(`  failed: ${e.message}`);
    await hub("/pages", { searchId: task.searchId, pages, seen, error: e.message.slice(0, 280) }).catch(() => {});
  } finally {
    await page.close().catch(() => {});
  }
}

/** Decide what a form field is for, from everything that names it. */
function fieldKind(f) {
  const s = `${f.name} ${f.id} ${f.placeholder} ${f.label} ${f.autocomplete}`.toLowerCase();
  if (f.tag === "textarea") return "message";
  if (f.type === "email" || /e-?mail/.test(s)) return "email";
  if (f.type === "tel" || /phone|mobile|\btel\b/.test(s)) return "phone";
  if (/first[\s_-]?name|given|\bfname\b/.test(s)) return "first";
  if (/last[\s_-]?name|surname|family|\blname\b/.test(s)) return "last";
  if (/company|organi[sz]ation|business name|firm/.test(s)) return "company";
  if (/subject/.test(s)) return "subject";
  if (/\bname\b|full[\s_-]?name|your name/.test(s)) return "name";
  return null;
}

/**
 * Fill a listing's contact form with an approved message. Returns the outcome for the hub:
 * sent, needs_human (with why), or failed.
 */
export async function fillContactForm(page, task, cfg) {
  const blocked = await obstacle(page);
  if (blocked) return { outcome: "needs_human", detail: blocked };

  let form = page.locator("form:has(textarea)").filter({ visible: true }).first();
  if (!(await form.count())) {
    // Many listings hide the form behind a "Contact seller" button.
    const opener = page.getByRole("button", { name: /contact (the )?(seller|broker|agent|owner|business)|send (a )?message|request (more )?info|inquire|make an inquiry/i }).first();
    if (await opener.count()) {
      await opener.click({ timeout: 5000 }).catch(() => {});
      await sleep(1500);
      form = page.locator("form:has(textarea)").filter({ visible: true }).first();
    }
  }
  if (!(await form.count())) return { outcome: "needs_human", detail: "No contact form found on the page (it may need a sign-in)" };

  if (await form.locator('iframe[src*="recaptcha/api2/anchor"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha').first().isVisible().catch(() => false)) {
    return { outcome: "needs_human", detail: "The contact form has a CAPTCHA" };
  }

  const fields = await form.locator("input, textarea, select").evaluateAll((els) =>
    els.map((el, i) => ({
      i,
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || "text").toLowerCase(),
      name: el.getAttribute("name") || "",
      id: el.id || "",
      placeholder: el.getAttribute("placeholder") || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      label: (el.labels && el.labels[0] ? el.labels[0].innerText : el.getAttribute("aria-label")) || "",
      required: el.required || el.getAttribute("aria-required") === "true",
      visible: !!(el.offsetWidth || el.offsetHeight),
      value: el.value || "",
    })),
  );
  const [first, ...rest] = (task.sender.name || "").trim().split(/\s+/);
  const values = { message: task.message, email: task.sender.email, phone: task.sender.phone, first, last: rest.join(" "), name: task.sender.name, company: task.sender.company, subject: task.subject };
  const all = form.locator("input, textarea, select");
  const unfilled = [];
  let wroteMessage = false;
  for (const f of fields) {
    if (!f.visible || ["hidden", "submit", "button", "checkbox", "radio", "file"].includes(f.type) || f.tag === "select") {
      if (f.visible && f.required && (f.tag === "select" || f.type === "checkbox" || f.type === "radio")) unfilled.push(f.label || f.name || f.type);
      continue;
    }
    const kind = fieldKind(f);
    const value = kind ? values[kind] : "";
    if (!value) {
      if (f.required && !f.value) unfilled.push(f.label || f.name || f.placeholder || "a required field");
      continue;
    }
    await all.nth(f.i).fill(value, { timeout: 5000 });
    if (kind === "message") wroteMessage = true;
    await sleep(between(200, 600));
  }
  if (!wroteMessage) return { outcome: "needs_human", detail: "Couldn't find the message box in the contact form" };
  if (unfilled.length) return { outcome: "needs_human", detail: `Filled in the message, but the form also requires: ${unfilled.slice(0, 4).join(", ")}` };
  if (!cfg.submitForms) return { outcome: "needs_human", detail: "Filled in and ready: press Send in the runner's browser (set submitForms to true to have the runner press it)" };

  const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').filter({ visible: true }).first();
  if (!(await submit.count())) return { outcome: "needs_human", detail: "Filled in, but couldn't find the send button" };
  await submit.click({ timeout: 8000 });
  await sleep(4000);
  const after = await obstacle(page);
  if (after) return { outcome: "needs_human", detail: `After pressing send, ${after}` };
  const confirmed = await page.getByText(/thank you|message (has been |was )?sent|inquiry (has been |was )?(sent|submitted|received)|we('ve| have) received|successfully (sent|submitted)|will be in touch/i).first().isVisible().catch(() => false);
  const gone = !(await form.isVisible().catch(() => false));
  if (confirmed || gone) return { outcome: "sent" };
  return { outcome: "needs_human", detail: "Pressed send, but the page didn't confirm it: check the runner's browser" };
}

export async function runContact(context, cfg, hub, task) {
  const page = await context.newPage();
  let result;
  try {
    log(`contact: ${task.listing ?? task.url}`);
    await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(between(2500, 5000));
    result = await fillContactForm(page, task, cfg);
  } catch (e) {
    result = { outcome: "failed", detail: e.message.slice(0, 280) };
  }
  log(`  ${result.outcome}${result.detail ? `: ${result.detail}` : ""}`);
  await hub("/contact-result", { messageId: task.messageId, ...result });
  // A form left for a person to send stays open; anything else is finished with.
  if (!(result.outcome === "needs_human" && /ready: press Send|check the runner/.test(result.detail ?? ""))) await page.close().catch(() => {});
}

async function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();

  if (args[0] === "--login") {
    const context = await openBrowser({ ...cfg, headless: false });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(args[1] ?? "about:blank").catch(() => {});
    log("Sign in in the browser window. Close the window when you're done; the session stays in the profile folder.");
    await new Promise((r) => context.on("close", r));
    return;
  }

  if (!cfg.hubUrl || cfg.token.length < 24) throw new Error("Set hubUrl and token in runner/config.json (copy config.example.json), or MAH_HUB_URL and MAH_TOKEN");
  const hub = hubClient(cfg);
  const context = await openBrowser(cfg);
  log(`runner ${VERSION} → ${cfg.hubUrl} (${cfg.capabilities.join(", ")}${cfg.submitForms ? ", submits forms" : ", leaves forms for you to send"})`);
  const once = args.includes("--once");
  for (;;) {
    let task = null;
    try {
      ({ task } = await hub("/work", { capabilities: cfg.capabilities, version: VERSION }));
      if (task?.kind === "source") await runSource(context, cfg, hub, task);
      else if (task?.kind === "contact") await runContact(context, cfg, hub, task);
    } catch (e) {
      log(`error: ${e.message}`);
    }
    if (once) break;
    await sleep((task ? between(8, 20) : cfg.pollSeconds) * 1000);
  }
  await context.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
