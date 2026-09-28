// The review server: the trajectory review command's local web server.
//
// A package is data; nothing renders a page for it. `relay_trajectory` hands a
// verified package to this server, which serves one static review app, the
// package's review data and the package's files on 127.0.0.1, and names the
// address the browser opens. The app renders the page from the data in the
// browser (src/relay-trajectory-viewer/). The server lives as long as the relay process
// and serves only the packages handed to it. UX: docs/ux-design.md §6.10.
import { execFile } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { deliveredPackageRun, reviewData } from '../package.js';
import { reviewCss } from './page.js';

/** The review app's script: built with the relay, or supplied by the caller (the dev server, tests). */
export type AppScript = () => Promise<string>;

// Package files come from the guest: none is served as a page or a script.
const types: Record<string, string> = {
  '.json': 'application/json; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.ndjson': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8', '.toml': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};
const html = 'text/html; charset=utf-8', plain = 'text/plain; charset=utf-8';
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const href = (...parts: string[]) => `/${parts.map(encodeURIComponent).join('/')}/`;
// The app may run only its own script and style, and ask only its own server.
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Relay review</title><link rel="stylesheet" href="/.app/review.css"><script type="module" src="/.app/review.js"></script></head><body><p class="loading">Reading the trajectory…</p></body></html>`;
const list = (title: string, items: [string, string][]) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><link rel="stylesheet" href="/.app/review.css"></head><body class="runs"><h1>${escape(title)}</h1><ul>${items.map(([h, text]) => `<li><a href="${escape(h)}">${escape(text)}</a></li>`).join('')}</ul></body></html>`;

const git = async (dir: string, ...args: string[]) => {
  try { return (await promisify(execFile)('git', ['-C', dir, ...args])).stdout.trim() || undefined; } catch { return undefined; }
};
/** The repository that ran the relay: its git remote's name, else its folder, else the package's parent folder. */
async function projectOf(dir: string) {
  const remote = await git(dir, 'remote', 'get-url', 'origin');
  if (remote) return basename(remote.replace(/\/+$/, '')).replace(/\.git$/, '');
  const top = await git(dir, 'rev-parse', '--show-toplevel');
  return basename(top ?? dirname(dir));
}
/** When the run's first step started, then the random suffix of the relay's task id. */
async function runOf(dir: string) {
  const { taskId, startedAt } = await deliveredPackageRun(dir);
  return `${startedAt.replace(/[:.]/g, '-')}-${/-([0-9a-f]{8})$/.exec(taskId)?.[1] ?? taskId}`;
}

export class ReviewServer {
  /** project → run → package folder */
  private readonly projects = new Map<string, Map<string, string>>();
  private server?: Server;
  private listening?: Promise<number>;

  constructor(private readonly script: AppScript, private readonly port = 0) {}

  /** Serve a package; returns the address of its page. The same package keeps its address. */
  async add(dir: string): Promise<string> {
    const root = await realpath(resolve(dir));
    const project = (await projectOf(root)).replace(/^\.+/, '') || 'package', run = await runOf(root);
    const runs = this.projects.get(project) ?? this.projects.set(project, new Map()).get(project)!;
    const existing = runs.get(run);
    if (existing && existing !== root) throw new Error(`${root} and ${existing} would both be served at /${project}/${run}/`);
    runs.set(run, root);
    return `http://127.0.0.1:${await this.listen()}${href(project, run)}`;
  }

  /** The packages served, as their page addresses. */
  async addresses(): Promise<string[]> {
    const port = await this.listen();
    return [...this.projects].flatMap(([project, runs]) => [...runs.keys()].map(run => `http://127.0.0.1:${port}${href(project, run)}`));
  }

  listen(): Promise<number> {
    this.listening ??= new Promise((done, fail) => {
      const server = createServer((request, response) => void this.handle(request.url ?? '/', request.headers.host, response));
      server.once('error', fail);
      server.listen(this.port, '127.0.0.1', () => { server.unref(); done((server.address() as AddressInfo).port); });
      this.server = server;
    });
    return this.listening;
  }

  close() { this.server?.close(); }

  private async handle(url: string, host: string | undefined, response: ServerResponse) {
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': policy, ...headers });
      response.end(body);
    };
    const redirect = (location: string) => { response.writeHead(301, { location }); response.end(); };
    try {
      // Only the browser that was given this address may ask: a page elsewhere
      // that rebinds a name to 127.0.0.1 carries its own name as the host.
      const port = await this.listen();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(421, plain, 'unknown host');
      const path = new URL(url, 'http://127.0.0.1').pathname;
      if (path === '/.app/review.js') return send(200, 'text/javascript; charset=utf-8', await this.script());
      if (path === '/.app/review.css') return send(200, 'text/css; charset=utf-8', reviewCss);
      const api = /^\/\.api\/([^/]+)\/([^/]+)\.json$/.exec(path);
      if (api) {
        const root = this.projects.get(decodeURIComponent(api[1]!))?.get(decodeURIComponent(api[2]!));
        return root ? send(200, types['.json']!, JSON.stringify(await reviewData(root))) : send(404, plain, 'unknown run');
      }
      const [, project = '', run, ...rest] = path.split('/').map(decodeURIComponent);
      if (!project) return send(200, html, list('Relay reviews', [...this.projects].flatMap(([p, runs]) => [...runs.keys()].map(r => [href(p, r), `${p} / ${r}`] as [string, string]))));
      const runs = this.projects.get(project);
      if (!runs) return send(404, plain, `unknown project ${project}`);
      if (run === undefined) return redirect(href(project));
      if (!run) return send(200, html, list(project, [...runs.keys()].map(r => [href(project, r), r])));
      const root = runs.get(run);
      if (!root) return send(404, plain, `unknown run ${run} of ${project}`);
      // The page refers to the package's files relatively, so it is served from the package's folder.
      if (!rest.length) return redirect(href(project, run));
      const file = rest.join('/');
      if (!file) return send(200, html, shell);
      const target = await realpath(resolve(root, file)).catch(() => undefined);
      if (!target || !target.startsWith(root + sep)) return send(404, plain, 'not in the package');
      return send(200, types[extname(target).toLowerCase()] ?? 'application/octet-stream', await readFile(target));
    } catch (error) {
      return send(500, plain, error instanceof Error ? error.message : String(error));
    }
  }
}
