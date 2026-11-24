// Bundles tests/*.test.ts with esbuild and runs them with Node's built-in test runner.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".test-dist");
rmSync(out, { recursive: true, force: true });
const entries = readdirSync(join(root, "tests"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join(root, "tests", f));
await build({ entryPoints: entries, outdir: out, bundle: true, platform: "node", format: "esm", outExtension: { ".js": ".mjs" }, logLevel: "warning" });
const files = readdirSync(out)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => join(out, f));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
process.exit(r.status ?? 1);
