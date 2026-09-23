import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Bundled, guest-only CLI. Never run `start` on the human's desktop. */
export interface BrowserConfig {
  stateDir: string; workspace: string; playwrightModule?: string;
  /** Where page captures land: inside the workspace so an extraction can carry them home. Default `<workspace>/browser-captures`. */
  captureDir: string;
  /** The longest the page is given to settle after an event before it is captured as it is. Default 5000. */
  settleTimeoutMs: number;
}
export type BrowserOperation =
  | { type: "navigate"; url: string }
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; text: string }
  | { type: "press"; selector: string; key: string }
  | { type: "read"; selector: string }
  | { type: "snapshot"; name?: string };
/**
 * How the page was waited for before a capture. Every field is a fact about
 * this wait, not a judgment: a false `networkIdle` says the page was captured
 * while still loading, and the reviewer decides what that means.
 */
export interface SettleNote {
  url: string; title: string;
  /** The main frame navigated or the address changed during the event. */
  navigated: boolean;
  loaded: boolean; networkIdle: boolean; fontsReady: boolean;
  waitedMs: number; timedOut: boolean;
}
export interface PageCapture {
  kind: "landing" | "snapshot"; name: string; seq: number;
  file: string; record: string; capturedAt: string; sha256: string; bytes: number;
  url: string; title: string; console: number; errors: number;
}
export interface BrowserState { version: 1; pid: number; port: number; token: string }
export const MAX_BROWSER_REQUEST_BYTES = 64 * 1024;
export const MAX_BROWSER_RESPONSE_BYTES = 32 * 1024;
export const DEFAULT_BROWSER_TIMEOUT_MS = 120_000;
export const MAX_BROWSER_TIMEOUT_MS = 3_600_000;
export const DEFAULT_SETTLE_TIMEOUT_MS = 5_000;
export const MAX_SETTLE_TIMEOUT_MS = 60_000;
/** Console lines kept between two captures; older lines are dropped and counted. */
const MAX_CONSOLE_LINES = 500;
const MAX_CONSOLE_TEXT = 2_000;
const START_TIMEOUT = 20_000;
const RECONCILE_TIMEOUT = 5000;
const RPC_ALLOWANCE = 10_000;
/** What the settle wait leaves of the request deadline for the capture that follows it. */
const CAPTURE_ALLOWANCE = 1_000;
export function validateBrowserTimeout(value: unknown = DEFAULT_BROWSER_TIMEOUT_MS): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_BROWSER_TIMEOUT_MS) throw new Error("timeoutMs must be an integer between 1 and 3600000");
  return value;
}
const stateFile = (dir: string) => join(dir, "state.json");
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const message = (error: unknown): string => String(error instanceof Error ? error.message : error).slice(0, 2000);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected one JSON object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.length) || value.includes("\0")) throw new Error(`Invalid ${name}`);
  return value;
}
export function validateOperation(value: unknown): BrowserOperation {
  const op = object(value);
  const fields: Record<string, string[]> = { navigate: ["type", "url"], click: ["type", "selector"], type: ["type", "selector", "text"], press: ["type", "selector", "key"], read: ["type", "selector"], snapshot: ["type", "name"] };
  const optional = ["name"];
  const keys = Object.hasOwn(fields, String(op.type)) ? fields[String(op.type)] : undefined;
  if (!keys || Object.keys(op).some((key) => !keys.includes(key))) throw new Error("Unsupported operation or extra fields; exactly one operation is required");
  for (const key of keys) { if (optional.includes(key) && op[key] === undefined) continue; text(op[key], key, key === "text"); }
  if (op.name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(op.name as string)) throw new Error("Invalid name: a capture name is a short safe identifier");
  if (op.type === "navigate") {
    const url = new URL(op.url as string);
    if (!["http:", "https:", "about:"].includes(url.protocol) || (url.protocol === "about:" && url.href !== "about:blank")) throw new Error("Only http(s) and about:blank navigation is supported");
  }
  return op as unknown as BrowserOperation;
}
async function boundedJson(path: string, max = MAX_BROWSER_REQUEST_BYTES): Promise<unknown> {
  if ((await stat(path)).size > max) throw new Error("JSON file exceeds size bound");
  const bytes = await readFile(path);
  if (bytes.length > max) throw new Error("JSON file exceeds size bound");
  return JSON.parse(bytes.toString("utf8"));
}
async function configFrom(path: string): Promise<BrowserConfig> {
  const raw = object(await boundedJson(path));
  if (Object.keys(raw).some((key) => !["stateDir", "workspace", "playwrightModule", "captureDir", "settleTimeoutMs"].includes(key))) throw new Error("Unknown browser config field");
  const workspace = await realpath(text(raw.workspace, "workspace"));
  const requestedStateDir = resolve(text(raw.stateDir, "stateDir"));
  const leaseRoot = dirname(workspace);
  const below = (parent: string, dir: string) => { const rel = relative(parent, dir); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  // Keep mutable profiles, locks, sockets and the channel token out of workspace extraction.
  const confined = (dir: string) => below(leaseRoot, dir) && dir !== workspace && !below(workspace, dir) && !below(dir, workspace);
  // Canonicalize before comparison, including /var -> /private/var on macOS.
  // Resolve the nearest existing ancestor before creating anything, rejecting symlink escapes.
  let ancestor = requestedStateDir;
  let stateDir: string;
  for (;;) {
    try { stateDir = resolve(await realpath(ancestor), relative(ancestor, requestedStateDir)); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = resolve(ancestor, ".."); }
  }
  if (!confined(stateDir)) throw new Error("stateDir must be inside the lease root and outside workspace (no symlink escapes or ancestors)");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (!confined(await realpath(stateDir))) throw new Error("stateDir symlink escapes lease confinement");
  const module = raw.playwrightModule === undefined ? undefined : text(raw.playwrightModule, "playwrightModule");
  if (module && !isAbsolute(module)) throw new Error("playwrightModule must be absolute");
  // Page captures are evidence the application extracts, so they live inside
  // the workspace; the same ancestor walk refuses symlink escapes out of it.
  const requestedCaptureDir = raw.captureDir === undefined ? join(workspace, "browser-captures") : resolve(text(raw.captureDir, "captureDir"));
  ancestor = requestedCaptureDir;
  let captureDir: string;
  for (;;) {
    try { captureDir = resolve(await realpath(ancestor), relative(ancestor, requestedCaptureDir)); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = resolve(ancestor, ".."); }
  }
  if (!below(workspace, captureDir)) throw new Error("captureDir must be inside the workspace (no symlink escapes)");
  await mkdir(captureDir, { recursive: true });
  if (!below(workspace, await realpath(captureDir))) throw new Error("captureDir symlink escapes the workspace");
  const settleTimeoutMs = raw.settleTimeoutMs === undefined ? DEFAULT_SETTLE_TIMEOUT_MS : raw.settleTimeoutMs;
  if (!Number.isInteger(settleTimeoutMs) || (settleTimeoutMs as number) < 0 || (settleTimeoutMs as number) > MAX_SETTLE_TIMEOUT_MS) throw new Error(`settleTimeoutMs must be an integer from 0 to ${MAX_SETTLE_TIMEOUT_MS}`);
  return { workspace, stateDir: await realpath(stateDir), captureDir: await realpath(captureDir), settleTimeoutMs: settleTimeoutMs as number, ...(module ? { playwrightModule: module } : {}) };
}
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "");
const safeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error("settle step timed out")), ms);
  work.then((value) => { clearTimeout(timer); done(value); }, (error) => { clearTimeout(timer); reject(error); });
});
/** Runs in the page: fonts loaded, then two animation frames so layout has been painted. */
const FONTS_AND_FRAMES = "() => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))";
export async function readBrowserState(dir: string): Promise<BrowserState> {
  const value = object(await boundedJson(stateFile(dir), 4096));
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 1 || !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535 || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("Invalid browser state");
  return value as unknown as BrowserState;
}
async function rpc(state: BrowserState, path: string, body?: unknown, timeoutMs = DEFAULT_BROWSER_TIMEOUT_MS): Promise<any> {
  const bytes = body === undefined ? "" : JSON.stringify(body);
  if (Buffer.byteLength(bytes) > MAX_BROWSER_REQUEST_BYTES) throw new Error("Browser request exceeds size bound");
  return new Promise((done, reject) => {
    const req = request({ hostname: "127.0.0.1", port: state.port, path, method: "POST", agent: false, headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(bytes), "x-browser-timeout-ms": String(timeoutMs) } }, (res) => {
      let length = 0; const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => { length += chunk.length; if (length > MAX_BROWSER_RESPONSE_BYTES) res.destroy(new Error("Browser response exceeds size bound")); else parts.push(chunk); });
      res.on("error", reject);
      res.on("end", () => { try { const result = JSON.parse(Buffer.concat(parts).toString("utf8")); if (res.statusCode !== 200 || result.ok !== true) throw new Error(result.error ?? `Browser HTTP ${res.statusCode}`); done(result); } catch (error) { reject(error); } });
    });
    const deadline = setTimeout(() => req.destroy(new Error("Browser request deadline exceeded; do not replay uncertain input")), timeoutMs + RPC_ALLOWANCE);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end(bytes);
  });
}
export async function callBrowser(dir: string, operation: unknown, timeoutMs?: number): Promise<unknown> {
  const timeout = validateBrowserTimeout(timeoutMs);
  return rpc(await readBrowserState(dir), "/call", validateOperation(operation), timeout);
}
export async function stopBrowser(dir: string): Promise<unknown> {
  // Never signal a PID from disk: it may have been reused. Authenticate to the live server instead.
  const state = await readBrowserState(dir);
  const result = await rpc(state, "/stop");
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try { const current = await readBrowserState(dir); if (current.token !== state.token) return result; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return result; throw error; }
    await sleep(25);
  }
  throw new Error("Browser stop did not complete; destroy the owning VM");
}

export async function serveBrowser(configPath: string): Promise<void> {
  const config = await configFrom(configPath);
  const lock = join(config.stateDir, "server.lock");
  await mkdir(lock, { mode: 0o700 }); // Fail closed on stale locks; no automatic profile reuse or PID killing.
  let browser: any;
  let browserTemp: string | undefined;
  let server: Server | undefined;
  let closing = false;
  let busy = false;
  let shutdownPromise: Promise<void> | undefined;
  const token = randomBytes(32).toString("hex");
  const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
    closing = true;
    // Playwright's own exit handlers remain installed; VM lease destruction is final authority.
    const watchdog = setTimeout(() => process.exit(1), 5000);
    try {
      server?.close();
      server?.closeIdleConnections();
      if (browser) await browser.close();
      if (browserTemp) await rm(browserTemp, { recursive: true, force: true });
      try { if ((await readBrowserState(config.stateDir)).token === token) await rm(stateFile(config.stateDir), { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rm(lock, { recursive: true, force: true });
    } finally { clearTimeout(watchdog); }
  })();
  const signal = () => { void shutdown().finally(() => process.exit(0)); };
  process.once("SIGTERM", signal); process.once("SIGINT", signal);
  try {
    // Chromium creates AF_UNIX sockets beneath TMPDIR. Lease paths can exceed
    // sun_path's 104/108-byte limit; a private short guest-only runtime directory
    // is required even though the durable state/token stays in the lease root.
    // mkdtemp is atomic (0700); never reuse a predictable directory or profile.
    browserTemp = await mkdtemp('/tmp/mvr-');
    process.env.TMPDIR = browserTemp; process.env.TMP = browserTemp; process.env.TEMP = browserTemp;
    const load = createRequire(join(config.workspace, "package.json"));
    const playwright = load(config.playwrightModule ?? "playwright");
    browser = await playwright.chromium.launch({ headless: false, timeout: START_TIMEOUT - 3000 });
    if (closing) { await browser.close(); return; }
    let context = await browser.newContext({ acceptDownloads: false });
    let page: any = await context.newPage();
    browser.on?.("disconnected", () => { if (!closing) void shutdown().finally(() => process.exit(1)); });
    // What the page said and where it went, kept between captures. The next
    // capture's record carries these lines, so nothing the page printed is lost
    // even when no capture follows the event that caused it.
    let navigations = 0, captures = 0, droppedConsole = 0;
    let consoleLines: Array<{ at: string; type: string; text: string }> = [];
    const pushConsole = (type: string, value: string) => {
      if (consoleLines.length >= MAX_CONSOLE_LINES) { droppedConsole++; return; }
      consoleLines.push({ at: new Date().toISOString(), type, text: String(value).slice(0, MAX_CONSOLE_TEXT) });
    };
    /** Observe one page; a fresh page after a cancelled action is observed the same way. */
    const watch = (target: any) => {
      target.on?.("console", (msg: any) => pushConsole(String(msg.type?.() ?? "log"), String(msg.text?.() ?? "")));
      target.on?.("pageerror", (error: any) => pushConsole("pageerror", message(error)));
      target.on?.("framenavigated", (frame: any) => { if (typeof target.mainFrame !== "function" || frame === target.mainFrame()) navigations++; });
    };
    watch(page);
    const pageUrl = (): string => page && typeof page.url === "function" ? String(page.url()) : "";
    const pageTitle = async (): Promise<string> => { try { return page && typeof page.title === "function" ? String(await withTimeout(page.title(), 2000)).slice(0, 500) : ""; } catch { return ""; } };
    /** Wait for the page to settle after an event, up to the configured limit and within what the request's deadline leaves for the capture, and report exactly how far it got. */
    const settle = async (before: { url: string; navigations: number }, limit: () => number): Promise<SettleNote> => {
      const started = Date.now(), deadline = started + Math.min(config.settleTimeoutMs, Math.max(1, limit() - CAPTURE_ALLOWANCE));
      const remaining = () => Math.max(1, deadline - Date.now());
      const navigated = () => navigations !== before.navigations || pageUrl() !== before.url;
      const note: SettleNote = { url: "", title: "", navigated: false, loaded: true, networkIdle: true, fontsReady: true, waitedMs: 0, timedOut: false };
      if (typeof page.waitForLoadState === "function") {
        // Playwright honours the timeout it is given; the outer bound also holds for any page implementation.
        if (navigated()) { try { await withTimeout(page.waitForLoadState("load", { timeout: remaining() }), remaining()); } catch { note.loaded = false; note.timedOut = true; } }
        try { await withTimeout(page.waitForLoadState("networkidle", { timeout: remaining() }), remaining()); } catch { note.networkIdle = false; note.timedOut = true; }
      }
      if (typeof page.evaluate === "function") {
        try { await withTimeout(page.evaluate(FONTS_AND_FRAMES), remaining()); } catch { note.fontsReady = false; note.timedOut = true; }
      }
      note.navigated = navigated(); note.url = pageUrl(); note.title = await pageTitle(); note.waitedMs = Date.now() - started;
      return note;
    };
    /** One page capture: the PNG, then a record beside it with the settle facts, the console lines since the last capture and the operation that led here. */
    const capture = async (kind: "landing" | "snapshot", name: string, settled: SettleNote, operation: BrowserOperation, limit: () => number): Promise<PageCapture> => {
      if (typeof page.screenshot !== "function") throw new Error("page capture unavailable: this Playwright page cannot take screenshots");
      const seq = ++captures, at = new Date();
      const base = `c${String(seq).padStart(6, "0")}-${stamp(at)}-${kind}-${safeName(name)}`;
      const file = join(config.captureDir, `${base}.png`), part = join(config.captureDir, `.${base}.part.png`);
      await page.screenshot({ path: part, type: "png", fullPage: false, timeout: limit() });
      await rename(part, file);
      const bytes = await readFile(file);
      if (!bytes.length) throw new Error("page capture wrote an empty file");
      const lines = consoleLines; const dropped = droppedConsole; consoleLines = []; droppedConsole = 0;
      const record = { version: 1, seq, kind, name, file: basename(file), capturedAt: at.toISOString(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, url: settled.url, title: settled.title, settled, operation, console: lines, consoleDropped: dropped };
      await writeFile(join(config.captureDir, `${base}.json`), `${JSON.stringify(record, null, 2)}\n`);
      return { kind, name, seq, file: record.file, record: `${base}.json`, capturedAt: record.capturedAt, sha256: record.sha256, bytes: record.bytes, url: record.url, title: record.title, console: lines.length + dropped, errors: lines.filter((line) => line.type === "pageerror").length };
    };
    server = createServer(async (req, res) => {
      const reply = (status: number, result: unknown) => { const bytes = JSON.stringify(result); res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end(bytes); };
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (req.method !== "POST" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(401, { ok: false, error: "Unauthorized" }); req.resume(); return; }
      if (req.url === "/health") { reply(200, { ok: true, pid: process.pid }); req.resume(); return; }
      if (req.url === "/stop") { reply(200, { ok: true }); req.resume(); void shutdown().finally(() => process.exit(0)); return; }
      if (req.url !== "/call") { reply(404, { ok: false, error: "Unknown endpoint" }); req.resume(); return; }
      // Reject overlap rather than queue invisible future input after its caller has timed out.
      if (busy || closing) { reply(409, { ok: false, error: "Browser busy or stopping; operation was not dispatched" }); req.resume(); return; }
      let timeoutMs: number;
      try { timeoutMs = validateBrowserTimeout(req.headers["x-browser-timeout-ms"] === undefined ? undefined : Number(req.headers["x-browser-timeout-ms"])); }
      catch (error) { reply(400, { ok: false, error: message(error) }); req.resume(); return; }
      busy = true;
      const deadline = Date.now() + timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let dispatched = false;
      let cancelled = false;
      let cancel!: (error: Error) => void;
      const cancellation = new Promise<never>((_, reject) => { cancel = reject; });
      const disconnect = () => { if (!res.writableEnded) { cancelled = true; cancel(new Error("Browser caller disconnected; input may have executed; do not replay")); } };
      res.once("close", disconnect);
      timer = setTimeout(() => { cancelled = true; cancel(new Error(`Browser operation deadline exceeded (${timeoutMs}ms); input may have executed; do not replay`)); }, timeoutMs);
      const remaining = () => {
        const ms = deadline - Date.now();
        if (cancelled || ms <= 0) throw new Error(`Browser operation deadline exceeded (${timeoutMs}ms); do not replay`);
        return ms;
      };
      try {
        const result = await Promise.race([cancellation, (async () => {
        let length = 0; const parts: Buffer[] = [];
        for await (const chunk of req) { length += chunk.length; if (length > MAX_BROWSER_REQUEST_BYTES) { reply(413, { ok: false, error: "Browser request exceeds size bound" }); return; } parts.push(Buffer.from(chunk)); }
        const op = validateOperation(JSON.parse(Buffer.concat(parts).toString("utf8")));
        remaining();
        // From here on input may reach the page: a failure must not read as "not sent".
        dispatched = true;
        if (!page || page.isClosed?.()) {
          page = undefined;
          await context.close();
          remaining();
          const freshContext = await browser.newContext({ acceptDownloads: false });
          if (cancelled || Date.now() >= deadline) { await freshContext.close(); remaining(); }
          context = freshContext;
          const freshPage = await context.newPage();
          remaining();
          page = freshPage;
          watch(page);
        }
        const options = { timeout: remaining() };
        const before = { url: pageUrl(), navigations };
        let result: unknown = null;
        switch (op.type) {
          case "navigate": await page.goto(op.url, { waitUntil: "domcontentloaded", ...options }); break;
          case "click": await page.locator(op.selector).click(options); break;
          case "type": await page.locator(op.selector).pressSequentially(op.text, options); break;
          case "press": await page.locator(op.selector).press(op.key, options); break;
          case "read": { const value = await page.locator(op.selector).innerText(options); result = { text: value.slice(0, 4000), truncated: value.length > 4000 }; break; }
          case "snapshot": break;
        }
        remaining();
        if (op.type === "snapshot") {
          const settled = await settle(before, remaining);
          result = { settled, capture: await capture("snapshot", op.name ?? "snapshot", settled, op, remaining) };
        } else if (op.type !== "read") {
          // Every input event is followed by a settle wait; an event that moved the
          // page to a new address also gets a landing capture of where it arrived.
          const settled = await settle(before, remaining);
          const landing = settled.navigated ? await capture("landing", op.type, settled, op, remaining) : null;
          result = { settled, landing };
        }
        remaining();
        return result;
        })()]);
        if (!res.writableEnded) reply(200, { ok: true, result });
      } catch (error) {
        let detail = message(error);
        if (dispatched) {
          // A rejected action may still have effects. Closing its context cancels
          // pending input; never reuse its page or automatically replay the action.
          page = undefined;
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([context.close(), new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error("context cancellation deadline exceeded")), RECONCILE_TIMEOUT); })]);
            detail += "; affected browser context closed; next operation uses a fresh page; do not replay";
          } catch (cleanupError) {
            closing = true;
            detail += `; cancellation unconfirmed: ${message(cleanupError)}; browser must be stopped before further input`;
          } finally { clearTimeout(cleanupTimer); }
        }
        // The caller's journal needs to know whether input reached the page before the failure.
        if (!res.destroyed && !res.writableEnded) reply(400, { ok: false, error: detail, dispatched });
      }
      finally { clearTimeout(timer); res.removeListener("close", disconnect); busy = false; }
    });
    // Action deadlines belong to each request, not a persistent socket/server timer.
    server.requestTimeout = MAX_BROWSER_TIMEOUT_MS + RPC_ALLOWANCE;
    server.headersTimeout = 20_000;
    server.setTimeout(0);
    await new Promise<void>((done, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", done); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing browser server port");
    const state: BrowserState = { version: 1, pid: process.pid, port: address.port, token };
    const temporaryState = join(config.stateDir, `state-${token}.json`);
    await writeFile(temporaryState, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await rename(temporaryState, stateFile(config.stateDir));
  } catch (error) {
    try { await writeFile(join(config.stateDir, "startup-error.json"), JSON.stringify({ error: message(error) }), { mode: 0o600 }); }
    finally { await shutdown(); }
    throw error;
  }
}

export async function startBrowser(configPath: string): Promise<unknown> {
  const config = await configFrom(configPath);
  const launchLock = join(config.stateDir, "launch.lock");
  await mkdir(launchLock, { mode: 0o700 });
  let child: ReturnType<typeof spawn> | undefined;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
  try {
    // Existing state/locks are deliberately not reclaimed: this is a disposable workspace.
    for (const file of [stateFile(config.stateDir), join(config.stateDir, "server.lock")]) {
      try { await stat(file); throw new Error("Browser state already exists; stop it or use a fresh stateDir"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    await rm(join(config.stateDir, "startup-error.json"), { force: true });
    // Bundle path is canonical even when /var is an alias of /private/var on macOS.
    const entry = await realpath(fileURLToPath(import.meta.url));
    if (interrupted) throw new Error("Browser startup interrupted");
    child = spawn(process.execPath, [entry, "serve", await realpath(configPath)], { detached: true, cwd: config.workspace, stdio: "ignore", env: { ...process.env } });
    let spawnError: Error | undefined;
    child.on("error", (error) => { spawnError = error; });
    const deadline = Date.now() + START_TIMEOUT;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error("Browser startup interrupted");
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        let detail = "Browser server exited before readiness";
        try { detail += `: ${message(object(await boundedJson(join(config.stateDir, "startup-error.json"))).error)}`; } catch { /* No startup detail available. */ }
        throw new Error(detail);
      }
      try {
        const state = await readBrowserState(config.stateDir);
        if (state.pid !== child.pid) throw new Error("Browser startup PID mismatch");
        const health = await rpc(state, "/health");
        if (health.pid !== child.pid) throw new Error("Browser health PID mismatch");
        child.unref(); return { ok: true, pid: state.pid, port: state.port };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await sleep(25);
    }
    throw new Error("Browser startup deadline exceeded");
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 6000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(25);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    throw error;
  } finally {
    process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt);
    await rm(launchLock, { recursive: true, force: true });
  }
}

async function main(args: string[]): Promise<void> {
  const [command, path, operation, timeout] = args;
  if (!path || !["start", "serve", "call", "stop"].includes(command) || !(command === "call" ? args.length === 3 || args.length === 4 : args.length === 2)) throw new Error("Usage: browser.mjs start|serve <configJsonFile> | call <stateDir> <operationJson> [timeoutMs] | stop <stateDir>");
  if (operation && Buffer.byteLength(operation) > MAX_BROWSER_REQUEST_BYTES) throw new Error("Browser request exceeds size bound");
  if (command === "serve") { await serveBrowser(path); return; }
  const result = command === "start" ? await startBrowser(path) : command === "stop" ? await stopBrowser(path) : await callBrowser(path, JSON.parse(operation!), timeout === undefined ? undefined : Number(timeout));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => "") === await realpath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, error: message(error) })}\n`); process.exitCode = 1; });
}
