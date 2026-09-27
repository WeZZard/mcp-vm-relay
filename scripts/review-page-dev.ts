// Development server for the evidence review page (src/review-page.ts).
//
// The relay renders a package's index.html from this template when it delivers
// the package. This server renders the page of each given delivered package
// again, with the current template, on every request, and serves the package's
// own files beside it. Nothing in the packages is changed. Under `tsx watch`,
// editing the template restarts the server, so a reload shows the edit.
//
//   npm run dev:review-page -- <package-dir>...
//
// Each package is served at /<project>/<run timestamp>-<run id>/. The project
// is the repository that ran the relay: the name of the git remote `origin` of
// the folder holding the package, else that repository's folder name, else the
// package's parent folder. The run timestamp is when the run's first step
// started, and the run id is the random suffix of the relay task id.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { deliveredPackageRun, renderDeliveredPage } from "../src/package.js";

const git = async (dir: string, ...args: string[]) => {
  try { return (await promisify(execFile)("git", ["-C", dir, ...args])).stdout.trim() || undefined; } catch { return undefined; }
};
async function projectOf(dir: string) {
  const remote = await git(dir, "remote", "get-url", "origin");
  if (remote) return basename(remote.replace(/\/+$/, "")).replace(/\.git$/, "");
  const top = await git(dir, "rev-parse", "--show-toplevel");
  return basename(top ?? dirname(dir));
}
async function runOf(dir: string) {
  const { taskId, startedAt } = await deliveredPackageRun(dir);
  return `${startedAt.replace(/[:.]/g, "-")}-${/-([0-9a-f]{8})$/.exec(taskId)?.[1] ?? taskId}`;
}

const dirs = process.argv.slice(2).map(dir => resolve(dir));
if (!dirs.length) {
  console.error("usage: npm run dev:review-page -- <package-dir>...");
  process.exit(2);
}
/** project → run → package folder */
const projects = new Map<string, Map<string, string>>();
for (const dir of dirs) {
  const project = await projectOf(dir), run = await runOf(dir);
  const runs = projects.get(project) ?? projects.set(project, new Map()).get(project)!;
  if (runs.has(run)) throw new Error(`${dir} and ${runs.get(run)} are both served at /${project}/${run}/`);
  runs.set(run, dir);
}

const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".jsonl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const href = (...parts: string[]) => `/${parts.map(encodeURIComponent).join("/")}/`;
const list = (title: string, items: [string, string][]) =>
  `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><h1>${escape(title)}</h1><ul>${items.map(([h, text]) => `<li><a href="${escape(h)}">${escape(text)}</a></li>`).join("")}</ul>`;
const port = Number(process.env.PORT ?? 8765);

createServer(async (request, response) => {
  const send = (status: number, type: string, body: string | Buffer) => {
    response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    response.end(body);
  };
  const redirect = (location: string) => {
    response.writeHead(301, { location });
    response.end();
  };
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const [, project = "", run, ...rest] = decodeURIComponent(url.pathname).split("/");
    if (!project) return send(200, types[".html"]!, list("Review pages", [...projects].flatMap(([p, runs]) => [...runs.keys()].map(r => [href(p, r), `${p} / ${r}`] as [string, string]))));
    const runs = projects.get(project);
    if (!runs) return send(404, types[".txt"]!, `unknown project ${project}`);
    if (run === undefined) return redirect(href(project));
    if (!run) return send(200, types[".html"]!, list(project, [...runs.keys()].map(r => [href(project, r), r])));
    const root = runs.get(run);
    if (!root) return send(404, types[".txt"]!, `unknown run ${run} of ${project}`);
    // The page refers to the package's files relatively, so it must be served from the package's folder.
    if (!rest.length) return redirect(href(project, run));
    const path = rest.join("/");
    if (!path || path === "index.html") return send(200, types[".html"]!, await renderDeliveredPage(root));
    const file = resolve(root, path);
    if (!file.startsWith(root + sep)) return send(403, types[".txt"]!, "outside the package");
    return send(200, types[extname(file)] ?? "application/octet-stream", await readFile(file));
  } catch (error) {
    return send(500, types[".txt"]!, error instanceof Error ? error.stack ?? error.message : String(error));
  }
}).listen(port, "127.0.0.1", () => {
  for (const [project, runs] of projects) for (const run of runs.keys()) console.log(`http://127.0.0.1:${port}${href(project, run)}`);
});
