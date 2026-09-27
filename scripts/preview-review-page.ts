// Renders the review page of an already delivered package with the current
// source, for design review on real evidence. The package itself is never
// changed: its originals are copied to a new directory under test-results/ and
// delivered there again.
//
//   npx tsx scripts/preview-review-page.ts <package-dir> [<name>]
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { deliverPackage } from "../src/package.js";

const [source, name] = process.argv.slice(2);
if (!source) {
  console.error("usage: preview-review-page.ts <package-dir> [<name>]");
  process.exit(2);
}
const generated = new Set(["manifest.json", "summary.json", "trajectory.json", "index.html", "OPENING.txt", "journal"]);
const root = resolve(source);
const { packageId, sessionId, taskId } = JSON.parse(await readFile(join(root, "summary.json"), "utf8"));
const out = resolve(import.meta.dirname, "../test-results/review-preview", name ?? basename(root));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(root, out, { recursive: true, filter: path => !generated.has(path.slice(root.length + 1)) });
const result = await deliverPackage(out, { packageId, sessionId, taskId });
console.log(`${join(out, "index.html")} (snapshots ${result.snapshots}, execution ${result.execution})`);
