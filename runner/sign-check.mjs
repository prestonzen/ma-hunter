// Sign one Documenso signing link with the runner's own sign step, to check it against your Documenso version.
//
//   node sign-check.mjs <signing url> "<name to sign as>" <page> <positionX> <positionY> <width> <height>
//
// The numbers are the signature field's place on the page, in percent from the top-left (as the hub stores them).
// Use a throwaway envelope: this really signs it. A temporary browser profile is used and removed afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { signDocument } from "./runner.mjs";

const [url, signerName, page = "1", x, y, w, h] = process.argv.slice(2);
if (!url || !signerName || h === undefined) {
  console.error('usage: node sign-check.mjs <signing url> "<name>" <page> <positionX> <positionY> <width> <height>');
  process.exit(2);
}
const profile = mkdtempSync(join(tmpdir(), "mah-sign-"));
const context = await chromium.launchPersistentContext(profile, { channel: process.env.MAH_CHANNEL ?? "chrome", headless: process.env.MAH_HEADED !== "1", viewport: { width: 1280, height: 900 } });
let result;
try {
  const p = await context.newPage();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  result = await signDocument(p, { signerName, fields: [{ type: "SIGNATURE", page: Number(page), positionX: Number(x), positionY: Number(y), width: Number(w), height: Number(h) }] });
  if (result.outcome !== "signed") await p.screenshot({ path: join(tmpdir(), "mah-sign-check.png") }).catch(() => {});
} catch (e) {
  result = { outcome: "failed", detail: e.message };
} finally {
  console.error(`sign step finished: ${JSON.stringify(result)}`);
  // Closing a persistent Chrome profile can hang on Windows; don't let it hold the result up.
  await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a file for a moment; the folder is in the temp directory either way.
  }
}
console.log(JSON.stringify(result));
process.exit(result.outcome === "signed" ? 0 : 1);
