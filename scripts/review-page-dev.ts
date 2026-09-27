// Development server for the evidence review page (src/review-page.ts).
//
// The relay renders a package's index.html from this template when it delivers
// the package. This server renders the page of each given delivered package
// again, with the current template, on every request, and serves the package's
// own files beside it. Nothing in the packages is changed. Under `tsx watch`,
// editing the template restarts the server, so a reload shows the edit.
//
//   npm run dev:review-page -- <package-dir>...
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { renderDeliveredPage } from "../src/package.js";

const packages = new Map(process.argv.slice(2).map(dir => [basename(resolve(dir)), resolve(dir)]));
if (!packages.size) {
  console.error("usage: npm run dev:review-page -- <package-dir>...");
  process.exit(2);
}
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".jsonl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const port = Number(process.env.PORT ?? 8765);

createServer(async (request, response) => {
  const send = (status: number, type: string, body: string | Buffer) => {
    response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    response.end(body);
  };
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const [, name = "", ...rest] = decodeURIComponent(url.pathname).split("/");
    if (!name) return send(200, types[".html"]!, `<!doctype html><title>Review pages</title><ul>${[...packages.keys()].map(n => `<li><a href="/${encodeURIComponent(n)}/">${escape(n)}</a></li>`).join("")}</ul>`);
    const root = packages.get(name);
    if (!root) return send(404, types[".txt"]!, `unknown package ${name}`);
    // The page refers to the package's files relatively, so it must be served from the package's folder.
    if (!rest.length) {
      response.writeHead(301, { location: `/${encodeURIComponent(name)}/` });
      return response.end();
    }
    const path = rest.join("/");
    if (!path || path === "index.html") return send(200, types[".html"]!, await renderDeliveredPage(root));
    const file = resolve(root, path);
    if (!file.startsWith(root + sep)) return send(403, types[".txt"]!, "outside the package");
    return send(200, types[extname(file)] ?? "application/octet-stream", await readFile(file));
  } catch (error) {
    return send(500, types[".txt"]!, error instanceof Error ? error.stack ?? error.message : String(error));
  }
}).listen(port, "127.0.0.1", () => {
  for (const name of packages.keys()) console.log(`http://127.0.0.1:${port}/${encodeURIComponent(name)}/`);
});
