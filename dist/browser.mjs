// src/guest/browser.ts
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
var MAX_BROWSER_REQUEST_BYTES = 64 * 1024;
var MAX_BROWSER_RESPONSE_BYTES = 32 * 1024;
var DEFAULT_BROWSER_TIMEOUT_MS = 12e4;
var MAX_BROWSER_TIMEOUT_MS = 36e5;
var DEFAULT_SETTLE_TIMEOUT_MS = 5e3;
var MAX_SETTLE_TIMEOUT_MS = 6e4;
var MAX_CONSOLE_LINES = 500;
var MAX_CONSOLE_TEXT = 2e3;
var START_TIMEOUT = 2e4;
var RECONCILE_TIMEOUT = 5e3;
var RPC_ALLOWANCE = 1e4;
var CAPTURE_ALLOWANCE = 1e3;
function validateBrowserTimeout(value = DEFAULT_BROWSER_TIMEOUT_MS) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_BROWSER_TIMEOUT_MS) throw new Error("timeoutMs must be an integer between 1 and 3600000");
  return value;
}
var stateFile = (dir) => join(dir, "state.json");
var sleep = (ms) => new Promise((done) => setTimeout(done, ms));
var message = (error) => String(error instanceof Error ? error.message : error).slice(0, 2e3);
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected one JSON object");
  return value;
}
function text(value, name, allowEmpty = false) {
  if (typeof value !== "string" || !allowEmpty && !value.length || value.includes("\0")) throw new Error(`Invalid ${name}`);
  return value;
}
function validateOperation(value) {
  const op = object(value);
  const fields = { navigate: ["type", "url"], click: ["type", "selector"], type: ["type", "selector", "text"], press: ["type", "selector", "key"], read: ["type", "selector"], snapshot: ["type", "name"] };
  const optional = ["name"];
  const keys = Object.hasOwn(fields, String(op.type)) ? fields[String(op.type)] : void 0;
  if (!keys || Object.keys(op).some((key) => !keys.includes(key))) throw new Error("Unsupported operation or extra fields; exactly one operation is required");
  for (const key of keys) {
    if (optional.includes(key) && op[key] === void 0) continue;
    text(op[key], key, key === "text");
  }
  if (op.name !== void 0 && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(op.name)) throw new Error("Invalid name: a capture name is a short safe identifier");
  if (op.type === "navigate") {
    const url = new URL(op.url);
    if (!["http:", "https:", "about:"].includes(url.protocol) || url.protocol === "about:" && url.href !== "about:blank") throw new Error("Only http(s) and about:blank navigation is supported");
  }
  return op;
}
async function boundedJson(path, max = MAX_BROWSER_REQUEST_BYTES) {
  if ((await stat(path)).size > max) throw new Error("JSON file exceeds size bound");
  const bytes = await readFile(path);
  if (bytes.length > max) throw new Error("JSON file exceeds size bound");
  return JSON.parse(bytes.toString("utf8"));
}
async function configFrom(path) {
  const raw = object(await boundedJson(path));
  if (Object.keys(raw).some((key) => !["stateDir", "workspace", "playwrightModule", "captureDir", "settleTimeoutMs"].includes(key))) throw new Error("Unknown browser config field");
  const workspace = await realpath(text(raw.workspace, "workspace"));
  const requestedStateDir = resolve(text(raw.stateDir, "stateDir"));
  const leaseRoot = dirname(workspace);
  const below = (parent, dir) => {
    const rel = relative(parent, dir);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const confined = (dir) => below(leaseRoot, dir) && dir !== workspace && !below(workspace, dir) && !below(dir, workspace);
  let ancestor = requestedStateDir;
  let stateDir;
  for (; ; ) {
    try {
      stateDir = resolve(await realpath(ancestor), relative(ancestor, requestedStateDir));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = resolve(ancestor, "..");
    }
  }
  if (!confined(stateDir)) throw new Error("stateDir must be inside the lease root and outside workspace (no symlink escapes or ancestors)");
  await mkdir(stateDir, { recursive: true, mode: 448 });
  if (!confined(await realpath(stateDir))) throw new Error("stateDir symlink escapes lease confinement");
  const module = raw.playwrightModule === void 0 ? void 0 : text(raw.playwrightModule, "playwrightModule");
  if (module && !isAbsolute(module)) throw new Error("playwrightModule must be absolute");
  const requestedCaptureDir = raw.captureDir === void 0 ? join(workspace, "browser-captures") : resolve(text(raw.captureDir, "captureDir"));
  ancestor = requestedCaptureDir;
  let captureDir;
  for (; ; ) {
    try {
      captureDir = resolve(await realpath(ancestor), relative(ancestor, requestedCaptureDir));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ancestor = resolve(ancestor, "..");
    }
  }
  if (!below(workspace, captureDir)) throw new Error("captureDir must be inside the workspace (no symlink escapes)");
  await mkdir(captureDir, { recursive: true });
  if (!below(workspace, await realpath(captureDir))) throw new Error("captureDir symlink escapes the workspace");
  const settleTimeoutMs = raw.settleTimeoutMs === void 0 ? DEFAULT_SETTLE_TIMEOUT_MS : raw.settleTimeoutMs;
  if (!Number.isInteger(settleTimeoutMs) || settleTimeoutMs < 0 || settleTimeoutMs > MAX_SETTLE_TIMEOUT_MS) throw new Error(`settleTimeoutMs must be an integer from 0 to ${MAX_SETTLE_TIMEOUT_MS}`);
  return { workspace, stateDir: await realpath(stateDir), captureDir: await realpath(captureDir), settleTimeoutMs, ...module ? { playwrightModule: module } : {} };
}
var stamp = (d) => d.toISOString().replace(/[-:]/g, "");
var safeName = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
var withTimeout = (work, ms) => new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error("settle step timed out")), ms);
  work.then((value) => {
    clearTimeout(timer);
    done(value);
  }, (error) => {
    clearTimeout(timer);
    reject(error);
  });
});
var FONTS_AND_FRAMES = "() => (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))";
async function readBrowserState(dir) {
  const value = object(await boundedJson(stateFile(dir), 4096));
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("Invalid browser state");
  return value;
}
async function rpc(state, path, body, timeoutMs = DEFAULT_BROWSER_TIMEOUT_MS) {
  const bytes = body === void 0 ? "" : JSON.stringify(body);
  if (Buffer.byteLength(bytes) > MAX_BROWSER_REQUEST_BYTES) throw new Error("Browser request exceeds size bound");
  return new Promise((done, reject) => {
    const req = request({ hostname: "127.0.0.1", port: state.port, path, method: "POST", agent: false, headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(bytes), "x-browser-timeout-ms": String(timeoutMs) } }, (res) => {
      let length = 0;
      const parts = [];
      res.on("data", (chunk) => {
        length += chunk.length;
        if (length > MAX_BROWSER_RESPONSE_BYTES) res.destroy(new Error("Browser response exceeds size bound"));
        else parts.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(parts).toString("utf8"));
          if (res.statusCode !== 200 || result.ok !== true) throw new Error(result.error ?? `Browser HTTP ${res.statusCode}`);
          done(result);
        } catch (error) {
          reject(error);
        }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("Browser request deadline exceeded; do not replay uncertain input")), timeoutMs + RPC_ALLOWANCE);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end(bytes);
  });
}
async function callBrowser(dir, operation, timeoutMs) {
  const timeout = validateBrowserTimeout(timeoutMs);
  return rpc(await readBrowserState(dir), "/call", validateOperation(operation), timeout);
}
async function stopBrowser(dir) {
  const state = await readBrowserState(dir);
  const result = await rpc(state, "/stop");
  const deadline = Date.now() + 7e3;
  while (Date.now() < deadline) {
    try {
      const current = await readBrowserState(dir);
      if (current.token !== state.token) return result;
    } catch (error) {
      if (error.code === "ENOENT") return result;
      throw error;
    }
    await sleep(25);
  }
  throw new Error("Browser stop did not complete; destroy the owning VM");
}
async function serveBrowser(configPath) {
  const config = await configFrom(configPath);
  const lock = join(config.stateDir, "server.lock");
  await mkdir(lock, { mode: 448 });
  let browser;
  let browserTemp;
  let server;
  let closing = false;
  let busy = false;
  let shutdownPromise;
  const token = randomBytes(32).toString("hex");
  const shutdown = () => shutdownPromise ??= (async () => {
    closing = true;
    const watchdog = setTimeout(() => process.exit(1), 5e3);
    try {
      server?.close();
      server?.closeIdleConnections();
      if (browser) await browser.close();
      if (browserTemp) await rm(browserTemp, { recursive: true, force: true });
      try {
        if ((await readBrowserState(config.stateDir)).token === token) await rm(stateFile(config.stateDir), { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await rm(lock, { recursive: true, force: true });
    } finally {
      clearTimeout(watchdog);
    }
  })();
  const signal = () => {
    void shutdown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", signal);
  process.once("SIGINT", signal);
  try {
    browserTemp = await mkdtemp("/tmp/mvr-");
    process.env.TMPDIR = browserTemp;
    process.env.TMP = browserTemp;
    process.env.TEMP = browserTemp;
    const load = createRequire(join(config.workspace, "package.json"));
    const playwright = load(config.playwrightModule ?? "playwright");
    browser = await playwright.chromium.launch({ headless: false, timeout: START_TIMEOUT - 3e3 });
    if (closing) {
      await browser.close();
      return;
    }
    let context = await browser.newContext({ acceptDownloads: false });
    let page = await context.newPage();
    browser.on?.("disconnected", () => {
      if (!closing) void shutdown().finally(() => process.exit(1));
    });
    let navigations = 0, captures = 0, droppedConsole = 0;
    let consoleLines = [];
    const pushConsole = (type, value) => {
      if (consoleLines.length >= MAX_CONSOLE_LINES) {
        droppedConsole++;
        return;
      }
      consoleLines.push({ at: (/* @__PURE__ */ new Date()).toISOString(), type, text: String(value).slice(0, MAX_CONSOLE_TEXT) });
    };
    const watch = (target) => {
      target.on?.("console", (msg) => pushConsole(String(msg.type?.() ?? "log"), String(msg.text?.() ?? "")));
      target.on?.("pageerror", (error) => pushConsole("pageerror", message(error)));
      target.on?.("framenavigated", (frame) => {
        if (typeof target.mainFrame !== "function" || frame === target.mainFrame()) navigations++;
      });
    };
    watch(page);
    const pageUrl = () => page && typeof page.url === "function" ? String(page.url()) : "";
    const pageTitle = async () => {
      try {
        return page && typeof page.title === "function" ? String(await withTimeout(page.title(), 2e3)).slice(0, 500) : "";
      } catch {
        return "";
      }
    };
    const settle = async (before, limit) => {
      const started = Date.now(), deadline = started + Math.min(config.settleTimeoutMs, Math.max(1, limit() - CAPTURE_ALLOWANCE));
      const remaining = () => Math.max(1, deadline - Date.now());
      const navigated = () => navigations !== before.navigations || pageUrl() !== before.url;
      const note = { url: "", title: "", navigated: false, loaded: true, networkIdle: true, fontsReady: true, waitedMs: 0, timedOut: false };
      if (typeof page.waitForLoadState === "function") {
        if (navigated()) {
          try {
            await withTimeout(page.waitForLoadState("load", { timeout: remaining() }), remaining());
          } catch {
            note.loaded = false;
            note.timedOut = true;
          }
        }
        try {
          await withTimeout(page.waitForLoadState("networkidle", { timeout: remaining() }), remaining());
        } catch {
          note.networkIdle = false;
          note.timedOut = true;
        }
      }
      if (typeof page.evaluate === "function") {
        try {
          await withTimeout(page.evaluate(FONTS_AND_FRAMES), remaining());
        } catch {
          note.fontsReady = false;
          note.timedOut = true;
        }
      }
      note.navigated = navigated();
      note.url = pageUrl();
      note.title = await pageTitle();
      note.waitedMs = Date.now() - started;
      return note;
    };
    const capture = async (kind, name, settled, operation, limit) => {
      if (typeof page.screenshot !== "function") throw new Error("page capture unavailable: this Playwright page cannot take screenshots");
      const seq = ++captures, at = /* @__PURE__ */ new Date();
      const base = `c${String(seq).padStart(6, "0")}-${stamp(at)}-${kind}-${safeName(name)}`;
      const file = join(config.captureDir, `${base}.png`), part = join(config.captureDir, `.${base}.part.png`);
      await page.screenshot({ path: part, type: "png", fullPage: false, timeout: limit() });
      await rename(part, file);
      const bytes = await readFile(file);
      if (!bytes.length) throw new Error("page capture wrote an empty file");
      const lines = consoleLines;
      const dropped = droppedConsole;
      consoleLines = [];
      droppedConsole = 0;
      const record = { version: 1, seq, kind, name, file: basename(file), capturedAt: at.toISOString(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, url: settled.url, title: settled.title, settled, operation, console: lines, consoleDropped: dropped };
      await writeFile(join(config.captureDir, `${base}.json`), `${JSON.stringify(record, null, 2)}
`);
      return { kind, name, seq, file: record.file, record: `${base}.json`, capturedAt: record.capturedAt, sha256: record.sha256, bytes: record.bytes, url: record.url, title: record.title, console: lines.length + dropped, errors: lines.filter((line) => line.type === "pageerror").length };
    };
    server = createServer(async (req, res) => {
      const reply = (status, result) => {
        const bytes = JSON.stringify(result);
        res.writeHead(status, { "content-type": "application/json", connection: "close" });
        res.end(bytes);
      };
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (req.method !== "POST" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        reply(401, { ok: false, error: "Unauthorized" });
        req.resume();
        return;
      }
      if (req.url === "/health") {
        reply(200, { ok: true, pid: process.pid });
        req.resume();
        return;
      }
      if (req.url === "/stop") {
        reply(200, { ok: true });
        req.resume();
        void shutdown().finally(() => process.exit(0));
        return;
      }
      if (req.url !== "/call") {
        reply(404, { ok: false, error: "Unknown endpoint" });
        req.resume();
        return;
      }
      if (busy || closing) {
        reply(409, { ok: false, error: "Browser busy or stopping; operation was not dispatched" });
        req.resume();
        return;
      }
      let timeoutMs;
      try {
        timeoutMs = validateBrowserTimeout(req.headers["x-browser-timeout-ms"] === void 0 ? void 0 : Number(req.headers["x-browser-timeout-ms"]));
      } catch (error) {
        reply(400, { ok: false, error: message(error) });
        req.resume();
        return;
      }
      busy = true;
      const deadline = Date.now() + timeoutMs;
      let timer;
      let dispatched = false;
      let cancelled = false;
      let cancel;
      const cancellation = new Promise((_, reject) => {
        cancel = reject;
      });
      const disconnect = () => {
        if (!res.writableEnded) {
          cancelled = true;
          cancel(new Error("Browser caller disconnected; input may have executed; do not replay"));
        }
      };
      res.once("close", disconnect);
      timer = setTimeout(() => {
        cancelled = true;
        cancel(new Error(`Browser operation deadline exceeded (${timeoutMs}ms); input may have executed; do not replay`));
      }, timeoutMs);
      const remaining = () => {
        const ms = deadline - Date.now();
        if (cancelled || ms <= 0) throw new Error(`Browser operation deadline exceeded (${timeoutMs}ms); do not replay`);
        return ms;
      };
      try {
        const result = await Promise.race([cancellation, (async () => {
          let length = 0;
          const parts = [];
          for await (const chunk of req) {
            length += chunk.length;
            if (length > MAX_BROWSER_REQUEST_BYTES) {
              reply(413, { ok: false, error: "Browser request exceeds size bound" });
              return;
            }
            parts.push(Buffer.from(chunk));
          }
          const op = validateOperation(JSON.parse(Buffer.concat(parts).toString("utf8")));
          remaining();
          dispatched = true;
          if (!page || page.isClosed?.()) {
            page = void 0;
            await context.close();
            remaining();
            const freshContext = await browser.newContext({ acceptDownloads: false });
            if (cancelled || Date.now() >= deadline) {
              await freshContext.close();
              remaining();
            }
            context = freshContext;
            const freshPage = await context.newPage();
            remaining();
            page = freshPage;
            watch(page);
          }
          const options = { timeout: remaining() };
          const before = { url: pageUrl(), navigations };
          let result2 = null;
          switch (op.type) {
            case "navigate":
              await page.goto(op.url, { waitUntil: "domcontentloaded", ...options });
              break;
            case "click":
              await page.locator(op.selector).click(options);
              break;
            case "type":
              await page.locator(op.selector).pressSequentially(op.text, options);
              break;
            case "press":
              await page.locator(op.selector).press(op.key, options);
              break;
            case "read": {
              const value = await page.locator(op.selector).innerText(options);
              result2 = { text: value.slice(0, 4e3), truncated: value.length > 4e3 };
              break;
            }
            case "snapshot":
              break;
          }
          remaining();
          if (op.type === "snapshot") {
            const settled = await settle(before, remaining);
            result2 = { settled, capture: await capture("snapshot", op.name ?? "snapshot", settled, op, remaining) };
          } else if (op.type !== "read") {
            const settled = await settle(before, remaining);
            const landing = settled.navigated ? await capture("landing", op.type, settled, op, remaining) : null;
            result2 = { settled, landing };
          }
          remaining();
          return result2;
        })()]);
        if (!res.writableEnded) reply(200, { ok: true, result });
      } catch (error) {
        let detail = message(error);
        if (dispatched) {
          page = void 0;
          let cleanupTimer;
          try {
            await Promise.race([context.close(), new Promise((_, reject) => {
              cleanupTimer = setTimeout(() => reject(new Error("context cancellation deadline exceeded")), RECONCILE_TIMEOUT);
            })]);
            detail += "; affected browser context closed; next operation uses a fresh page; do not replay";
          } catch (cleanupError) {
            closing = true;
            detail += `; cancellation unconfirmed: ${message(cleanupError)}; browser must be stopped before further input`;
          } finally {
            clearTimeout(cleanupTimer);
          }
        }
        if (!res.destroyed && !res.writableEnded) reply(400, { ok: false, error: detail, dispatched });
      } finally {
        clearTimeout(timer);
        res.removeListener("close", disconnect);
        busy = false;
      }
    });
    server.requestTimeout = MAX_BROWSER_TIMEOUT_MS + RPC_ALLOWANCE;
    server.headersTimeout = 2e4;
    server.setTimeout(0);
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing browser server port");
    const state = { version: 1, pid: process.pid, port: address.port, token };
    const temporaryState = join(config.stateDir, `state-${token}.json`);
    await writeFile(temporaryState, JSON.stringify(state), { mode: 384, flag: "wx" });
    await rename(temporaryState, stateFile(config.stateDir));
  } catch (error) {
    try {
      await writeFile(join(config.stateDir, "startup-error.json"), JSON.stringify({ error: message(error) }), { mode: 384 });
    } finally {
      await shutdown();
    }
    throw error;
  }
}
async function startBrowser(configPath) {
  const config = await configFrom(configPath);
  const launchLock = join(config.stateDir, "launch.lock");
  await mkdir(launchLock, { mode: 448 });
  let child;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  try {
    for (const file of [stateFile(config.stateDir), join(config.stateDir, "server.lock")]) {
      try {
        await stat(file);
        throw new Error("Browser state already exists; stop it or use a fresh stateDir");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await rm(join(config.stateDir, "startup-error.json"), { force: true });
    const entry = await realpath(fileURLToPath(import.meta.url));
    if (interrupted) throw new Error("Browser startup interrupted");
    child = spawn(process.execPath, [entry, "serve", await realpath(configPath)], { detached: true, cwd: config.workspace, stdio: "ignore", env: { ...process.env } });
    let spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    const deadline = Date.now() + START_TIMEOUT;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error("Browser startup interrupted");
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        let detail = "Browser server exited before readiness";
        try {
          detail += `: ${message(object(await boundedJson(join(config.stateDir, "startup-error.json"))).error)}`;
        } catch {
        }
        throw new Error(detail);
      }
      try {
        const state = await readBrowserState(config.stateDir);
        if (state.pid !== child.pid) throw new Error("Browser startup PID mismatch");
        const health = await rpc(state, "/health");
        if (health.pid !== child.pid) throw new Error("Browser health PID mismatch");
        child.unref();
        return { ok: true, pid: state.pid, port: state.port };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await sleep(25);
    }
    throw new Error("Browser startup deadline exceeded");
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 6e3;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(25);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    throw error;
  } finally {
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
    await rm(launchLock, { recursive: true, force: true });
  }
}
async function main(args) {
  const [command, path, operation, timeout] = args;
  if (!path || !["start", "serve", "call", "stop"].includes(command) || !(command === "call" ? args.length === 3 || args.length === 4 : args.length === 2)) throw new Error("Usage: browser.mjs start|serve <configJsonFile> | call <stateDir> <operationJson> [timeoutMs] | stop <stateDir>");
  if (operation && Buffer.byteLength(operation) > MAX_BROWSER_REQUEST_BYTES) throw new Error("Browser request exceeds size bound");
  if (command === "serve") {
    await serveBrowser(path);
    return;
  }
  const result = command === "start" ? await startBrowser(path) : command === "stop" ? await stopBrowser(path) : await callBrowser(path, JSON.parse(operation), timeout === void 0 ? void 0 : Number(timeout));
  process.stdout.write(`${JSON.stringify(result)}
`);
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => "") === await realpath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: message(error) })}
`);
    process.exitCode = 1;
  });
}
export {
  DEFAULT_BROWSER_TIMEOUT_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
  MAX_BROWSER_REQUEST_BYTES,
  MAX_BROWSER_RESPONSE_BYTES,
  MAX_BROWSER_TIMEOUT_MS,
  MAX_SETTLE_TIMEOUT_MS,
  callBrowser,
  readBrowserState,
  serveBrowser,
  startBrowser,
  stopBrowser,
  validateBrowserTimeout,
  validateOperation
};
