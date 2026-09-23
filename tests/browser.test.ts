import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, realpath, mkdtemp, mkdir, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { MAX_BROWSER_REQUEST_BYTES, MAX_BROWSER_RESPONSE_BYTES, readBrowserState, validateOperation, callBrowser, validateBrowserTimeout, DEFAULT_BROWSER_TIMEOUT_MS, MAX_BROWSER_TIMEOUT_MS } from "../src/guest/browser.js";

const source = resolve("src/guest/browser.ts");
const fake = `const fs = require('node:fs');
const path = require('node:path');
const log = value => fs.appendFileSync(path.join(__dirname, 'events.jsonl'), JSON.stringify(value)+'\\n');
module.exports.chromium = {launch: async options => {
  log({event:'launch',options,tmp:process.env.TMPDIR,pid:process.pid});
  let currentUrl = 'about:blank', value = '', clicks = 0;
  return {
    close: async () => log({event:'close'}), on() {},
    newContext: async options => {log({event:'context',options}); let closed=false; let cancel; return {
      close: async () => {closed=true; cancel?.(); log({event:'context-close'});},
      newPage: async () => {log({event:'page'}); const handlers = {}; const frame = {}; return {
        setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
        on(name, fn) { handlers[name] = fn; }, mainFrame: () => frame,
        url: () => currentUrl, title: async () => 'Fake ' + currentUrl,
        waitForLoadState: async (state) => { log({event:'wait',state}); if (currentUrl.includes('never-idle') && state === 'networkidle') await new Promise(r => setTimeout(r, 10000)); },
        evaluate: async () => {},
        screenshot: async options => { log({event:'screenshot',path:options.path}); if (currentUrl.includes('no-shot')) throw new Error('fake screenshot failed'); fs.writeFileSync(options.path, Buffer.from('PNG' + currentUrl + clicks)); },
        goto: async (url,options) => {log({event:'navigate',url,options}); currentUrl=url; handlers.framenavigated?.(frame); handlers.console?.({type:()=>'log',text:()=>'arrived at '+url});},
        locator: selector => ({
          click: async options => {log({event:'click-start',selector,options}); if(selector==='#slow'||selector==='#hang')await new Promise((r,reject)=>{const timer=setTimeout(r,selector==='#slow'?800:60000); cancel=()=>{clearTimeout(timer);reject(new Error('context closed'));};}); if(closed)throw new Error('context closed'); if(selector==='#fail')throw new Error('fake click failed'); clicks++; if(selector==='#go'){currentUrl='https://example.test/after-click'; handlers.framenavigated?.(frame);} if(selector==='#boom')handlers.pageerror?.(new Error('fake page error')); log({event:'click-end',selector});},
          pressSequentially: async text => {log({event:'type',selector,text}); value+=text;},
          press: async key => {log({event:'press',selector,key}); value+='['+key+']';},
          innerText: async () => {log({event:'read',selector}); return selector==='#huge'?'\\u0001'.repeat(100000):JSON.stringify({url:currentUrl,value,clicks});}
        })
      };}
    };}
  };
}};`;
interface CliResult { code: number | null; stdout: string; stderr: string }
function cli(entry: string, ...args: string[]): Promise<CliResult> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 35_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      // Model the receiver's per-dispatch process-group cleanup. The browser server
      // must survive because start created its own detached process group.
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { reject(error); return; } }
      done({ code, stdout, stderr });
    });
  });
}
async function setup(t: { after(fn: () => Promise<unknown>): void }, start = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-relay-browser-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const entry = join(root, "browser.mjs"), stateDir = join(root, "browser"), config = join(root, "config.json"), module = join(root, "fake-playwright.cjs");
  await build({ entryPoints: [source], outfile: entry, bundle: true, format: "esm", platform: "node", target: "node22" });
  await writeFile(module, fake);
  await writeFile(config, JSON.stringify({ stateDir, workspace, playwrightModule: module }));
  t.after(async () => { try { await cli(entry, "stop", stateDir); } finally { await rm(root, { recursive: true, force: true }); } });
  if (start) { const result = await cli(entry, "start", config); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ok, true); }
  const events = async (): Promise<any[]> => (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const call = (operation: unknown, timeoutMs?: number) => cli(entry, "call", stateDir, JSON.stringify(operation), ...(timeoutMs === undefined ? [] : [String(timeoutMs)]));
  return { root, workspace, entry, stateDir, config, module, events, call };
}
async function raw(stateDir: string, body: unknown, token?: string) {
  const state = await readBrowserState(stateDir);
  const response = await fetch(`http://127.0.0.1:${state.port}/call`, { method: "POST", headers: { authorization: `Bearer ${token ?? state.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: response.status, data: await response.json() };
}

test("detached server persists one fresh page across separately executed browser calls", async (t) => {
  const { stateDir, events, call } = await setup(t);
  const original = await readBrowserState(stateDir);
  for (const operation of [
    { type: "navigate", url: "https://example.test/one" },
    { type: "type", selector: "#field", text: "hello " },
    { type: "type", selector: "#field", text: "world" },
    { type: "press", selector: "#field", key: "Enter" },
    { type: "click", selector: "#submit" },
  ]) { const result = await call(operation); assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim().split("\n").length, 1); }
  const read = await call({ type: "read", selector: "body" });
  assert.equal(read.code, 0, read.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(read.stdout).result.text), { url: "https://example.test/one", value: "hello world[Enter]", clicks: 1 });
  assert.deepEqual(await readBrowserState(stateDir), original);
  const history = await events();
  assert.equal(history.filter((event) => event.event === "launch").length, 1);
  assert.equal(history.filter((event) => event.event === "context").length, 1);
  assert.equal(history.filter((event) => event.event === "page").length, 1);
  assert.deepEqual(history[0].options, { headless: false, timeout: 17000 });
  assert.match(history[0].tmp, /^\/tmp\/mvr-[A-Za-z0-9]+$/);
  assert.equal((await stat(history[0].tmp)).mode & 0o777, 0o700);
  assert.equal((await stat(join(stateDir, "state.json"))).mode & 0o777, 0o600);
});

test("long lease paths use short private socket directories cleaned on stop", async t => {
  const f = await setup(t, false);
  const lease = join(f.root, 'long-lease-'.repeat(16));
  const workspace = join(lease, 'workspace'), stateDir = join(lease, 'browser');
  await mkdir(workspace, { recursive: true });
  await writeFile(f.config, JSON.stringify({ stateDir, workspace, playwrightModule: f.module }));
  try {
    const result = await cli(f.entry, 'start', f.config);
    assert.equal(result.code, 0, result.stderr);
    const temp = (await f.events())[0].tmp;
    assert.ok(Buffer.byteLength(join(temp, 'playwright_chromiumdev_profile-XXXXXX', 'SingletonSocket')) < 104);
    assert.equal((await cli(f.entry, 'stop', stateDir)).code, 0);
    await assert.rejects(stat(temp), { code: 'ENOENT' });
  } finally { await cli(f.entry, 'stop', stateDir); }
});

test("local channel authenticates requests and rejects batches, eval, and extra fields without input", async (t) => {
  const { stateDir, events, call } = await setup(t);
  const baseline = (await events()).length;
  assert.equal((await raw(stateDir, { type: "click", selector: "#submit" }, "wrong-token")).status, 401);
  for (const bad of [[], [{ type: "click", selector: "#submit" }], { type: "eval", code: "1" }, { type: "click", selector: "#submit", next: { type: "click" } }, { type: "navigate", url: "javascript:alert(1)" }, { type: "navigate", url: "file:///etc/passwd" }]) {
    const result = await call(bad); assert.equal(result.code, 1); assert.equal(result.stdout, "");
    assert.equal((await raw(stateDir, bad)).status, 400);
  }
  assert.equal((await events()).length, baseline);
});

test("overlapping calls are refused, not silently queued or dispatched", async (t) => {
  const { stateDir, events } = await setup(t);
  const first = raw(stateDir, { type: "click", selector: "#slow" });
  const deadline = Date.now() + 4000;
  while (!(await events()).some((event) => event.event === "click-start") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.ok((await events()).some((event) => event.event === "click-start"));
  const overlap = await raw(stateDir, { type: "click", selector: "#not-dispatched" });
  assert.equal(overlap.status, 409);
  assert.equal((await first).status, 200);
  assert.deepEqual((await events()).filter((event) => event.event === "click-start").map((event) => event.selector), ["#slow"]);
});

test("read output stays bounded, errors exit nonzero, and oversized input never dispatches", async (t) => {
  const { call, events, stateDir } = await setup(t);
  const huge = await call({ type: "read", selector: "#huge" });
  assert.equal(huge.code, 0, huge.stderr);
  assert.ok(Buffer.byteLength(huge.stdout) <= MAX_BROWSER_RESPONSE_BYTES);
  assert.equal(JSON.parse(huge.stdout).result.truncated, true);
  const failed = await call({ type: "click", selector: "#fail" });
  assert.equal(failed.code, 1); assert.match(failed.stderr, /fake click failed/);
  const count = (await events()).length;
  const oversized = { type: "type", selector: "#field", text: "x".repeat(MAX_BROWSER_REQUEST_BYTES + 1) };
  assert.equal((await call(oversized)).code, 1);
  assert.equal((await raw(stateDir, oversized)).status, 413);
  assert.equal((await events()).length, count);
});

test("stop gracefully closes browser, removes live state, and never reuses an existing instance", async (t) => {
  const { entry, config, stateDir, events } = await setup(t);
  const state = await readBrowserState(stateDir);
  const duplicate = await cli(entry, "start", config);
  assert.equal(duplicate.code, 1); assert.match(duplicate.stderr, /already exists/);
  assert.deepEqual(await readBrowserState(stateDir), state);
  const stop = await cli(entry, "stop", stateDir);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal((await events()).filter((event) => event.event === "close").length, 1);
  await assert.rejects(stat(join(stateDir, "state.json")), { code: "ENOENT" });
  await assert.rejects(stat(join(stateDir, "server.lock")), { code: "ENOENT" });
});

test("startup failure surfaces loader error and releases locks without downloading anything", async (t) => {
  const { entry, root, workspace, config, stateDir } = await setup(t, false);
  await writeFile(config, JSON.stringify({ workspace, stateDir, playwrightModule: join(root, "missing.cjs") }));
  const start = await cli(entry, "start", config);
  assert.equal(start.code, 1); assert.match(start.stderr, /Cannot find module/);
  await assert.rejects(stat(join(stateDir, "server.lock")), { code: "ENOENT" });
  await assert.rejects(stat(join(stateDir, "launch.lock")), { code: "ENOENT" });
  await assert.rejects(stat(join(stateDir, "state.json")), { code: "ENOENT" });
});

test("default Playwright loader resolves from workspace and canonical CLI works through symlinks", async (t) => {
  const { root, workspace, entry, config, stateDir } = await setup(t, false);
  const moduleDir = join(workspace, "node_modules/playwright");
  await mkdir(moduleDir, { recursive: true });
  await writeFile(join(moduleDir, "package.json"), JSON.stringify({ name: "playwright", main: "index.cjs" }));
  await writeFile(join(moduleDir, "index.cjs"), fake);
  await writeFile(config, JSON.stringify({ workspace, stateDir }));
  const link = join(root, "entry-alias.mjs"); await symlink(entry, link);
  const start = await cli(link, "start", config);
  assert.equal(start.code, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).pid, (await readBrowserState(stateDir)).pid);
});

test("stale PID state never signals a foreign process and lease root escapes fail closed", async (t) => {
  const { root, workspace, entry, config, stateDir, module } = await setup(t, false);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "state.json"), JSON.stringify({ version: 1, pid: process.pid, port: 1, token: "a".repeat(64) }));
  assert.equal((await cli(entry, "stop", stateDir)).code, 1);
  assert.equal((await cli(entry, "start", config)).code, 1);
  await writeFile(config, JSON.stringify({ workspace, stateDir: resolve(root, "..", "escape"), playwrightModule: module }));
  const escape = await cli(entry, "start", config);
  assert.equal(escape.code, 1); assert.match(escape.stderr, /inside the lease root/);
});

test("SIGTERM shuts down the owned server and closes its browser", async (t) => {
  const { stateDir, events } = await setup(t);
  const { pid } = await readBrowserState(stateDir);
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await stat(join(stateDir, "state.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    await new Promise((done) => setTimeout(done, 10));
  }
  await assert.rejects(stat(join(stateDir, "state.json")), { code: "ENOENT" });
  assert.equal((await events()).filter((event) => event.event === "close").length, 1);
});

test("startup failure after launch closes the newly owned browser", async (t) => {
  const { module, entry, config, events, stateDir } = await setup(t, false);
  await writeFile(module, fake.replace("newContext: async options => {log", "newContext: async options => {throw new Error('context failed');log"));
  const start = await cli(entry, "start", config);
  assert.equal(start.code, 1); assert.match(start.stderr, /context failed/);
  assert.equal((await events()).filter((event) => event.event === "close").length, 1);
  await assert.rejects(stat(join(stateDir, "server.lock")), { code: "ENOENT" });
});

test("interrupted start terminates its detached child instead of orphaning a browser", async (t) => {
  const { module, entry, config, events, stateDir } = await setup(t, false);
  await writeFile(module, fake.replace("newContext: async options => {log", "newContext: async options => {await new Promise(r=>setTimeout(r,10000));log"));
  const child = spawn(process.execPath, [entry, "start", config], { stdio: "ignore" });
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const deadline = Date.now() + 5000;
  let launched = false;
  while (Date.now() < deadline) {
    try { launched = (await events()).some((event) => event.event === "launch"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (launched) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(launched, true);
  child.kill("SIGTERM");
  assert.equal(await exited, 1);
  assert.equal((await events()).filter((event) => event.event === "close").length, 1);
  await assert.rejects(stat(join(stateDir, "server.lock")), { code: "ENOENT" });
  await assert.rejects(stat(join(stateDir, "launch.lock")), { code: "ENOENT" });
});

test("stateDir symlink escapes are rejected before file creation", async (t) => {
  const { root, workspace, entry, config, module } = await setup(t, false);
  const outside = await realpath(await mkdtemp(join(tmpdir(), "pi-relay-browser-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const link = join(root, "escape"); await symlink(outside, link);
  await writeFile(config, JSON.stringify({ workspace, stateDir: join(link, "new-state"), playwrightModule: module }));
  const result = await cli(entry, "start", config);
  assert.equal(result.code, 1); assert.match(result.stderr, /symlink escapes/);
  await assert.rejects(stat(join(outside, "new-state")), { code: "ENOENT" });
});

test("state cannot overlap workspace extraction or use lease ancestors", async (t) => {
  const { root, workspace, entry, config, module } = await setup(t, false);
  const intoWorkspace = join(root, "workspace-alias"); await symlink(workspace, intoWorkspace);
  for (const stateDir of [workspace, join(workspace, "browser"), root, resolve(root, ".."), intoWorkspace, join(intoWorkspace, "browser")]) {
    await writeFile(config, JSON.stringify({ workspace, stateDir, playwrightModule: module }));
    const result = await cli(entry, "start", config);
    assert.equal(result.code, 1, stateDir); assert.match(result.stderr, /outside workspace/);
  }
  await assert.rejects(stat(join(workspace, "browser")), { code: "ENOENT" });
  await assert.rejects(stat(join(workspace, "state.json")), { code: "ENOENT" });
});

test("timeout bounds reject invalid values before state access or input", async (t) => {
  assert.equal(validateBrowserTimeout(), 120000);
  assert.equal(validateBrowserTimeout(MAX_BROWSER_TIMEOUT_MS), 3600000);
  const f = await setup(t);
  const baseline = (await f.events()).length;
  for (const value of [0, -1, 1.5, NaN, Infinity, 3600001]) {
    assert.throws(() => validateBrowserTimeout(value), /timeoutMs/);
    await assert.rejects(callBrowser("/missing-state", { type: "click", selector: "#x" }, value), /timeoutMs/);
    const result = await f.call({ type: "click", selector: "#x" }, value);
    assert.equal(result.code, 1); assert.match(result.stderr, /timeoutMs/);
  }
  const state = await readBrowserState(f.stateDir);
  for (const value of ["0", "3600001", "invalid", "1.5"]) {
    const response = await fetch(`http://127.0.0.1:${state.port}/call`, { method: "POST", headers: { authorization: `Bearer ${state.token}`, "x-browser-timeout-ms": value }, body: JSON.stringify({ type: "click", selector: "#x" }) });
    assert.equal(response.status, 400); assert.match(await response.text(), /timeoutMs/);
  }
  assert.equal((await f.events()).length, baseline);
});

test("configured and default deadlines reach Playwright independently on persistent calls", async (t) => {
  const f = await setup(t);
  for (const timeout of [MAX_BROWSER_TIMEOUT_MS, undefined, 250000, undefined]) {
    const result = await f.call({ type: "click", selector: "#submit" }, timeout);
    assert.equal(result.code, 0, result.stderr);
    const event = (await f.events()).filter(event => event.event === "click-start").at(-1);
    const expected = timeout ?? DEFAULT_BROWSER_TIMEOUT_MS;
    assert.ok(event.options.timeout > expected - 1000, JSON.stringify(event));
    assert.ok(event.options.timeout <= expected);
  }
  assert.equal((await f.events()).filter(event => event.event === "page").length, 1);
});

test("configured action can finish beyond the former 15-second action and 20-second RPC limits", async (t) => {
  const f = await setup(t, false);
  await writeFile(f.module, fake.replace("selector==='#slow'?800:60000", "selector==='#slow'?21000:60000"));
  const start = await cli(f.entry, "start", f.config);
  assert.equal(start.code, 0, start.stderr);
  const result = await f.call({ type: "click", selector: "#slow" }, 30000);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await f.events()).filter(event => event.event === "click-end").length, 1);
});

test("deadline cancels pending input before reply and next operation creates a fresh page", async (t) => {
  const f = await setup(t);
  const original = await readBrowserState(f.stateDir);
  for (let i = 0; i < 2; i++) {
    const result = await f.call({ type: "click", selector: "#hang" }, 100);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /deadline exceeded \(100ms\)/);
    assert.match(result.stderr, /context closed/);
    const next = await f.call({ type: "click", selector: "#slow" }, 1200);
    assert.equal(next.code, 0, next.stderr);
  }
  const history = await f.events();
  assert.equal(history.filter(event => event.event === "click-end" && event.selector === "#hang").length, 0);
  assert.equal(history.filter(event => event.event === "page").length, 3);
  assert.deepEqual(await readBrowserState(f.stateDir), original);
});

test("caller disconnect cancels the affected context without replay", async (t) => {
  const f = await setup(t);
  const state = await readBrowserState(f.stateDir);
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${state.port}/call`, { method: "POST", headers: { authorization: `Bearer ${state.token}` }, body: JSON.stringify({ type: "click", selector: "#hang" }), signal: controller.signal }).catch(() => undefined);
  const deadline = Date.now() + 4000;
  while (!(await f.events()).some(event => event.event === "click-start") && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  assert.ok((await f.events()).some(event => event.event === "click-start"));
  controller.abort(); await pending;
  while (!(await f.events()).some(event => event.event === "context-close") && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
  assert.ok((await f.events()).some(event => event.event === "context-close"));
  const next = await f.call({ type: "read", selector: "body" });
  assert.equal(next.code, 0, next.stderr);
  assert.equal((await f.events()).filter(event => event.event === "click-end").length, 0);
});

test("operation schema rejects missing properties and arbitrary method names", () => {
  for (const value of [null, { type: "constructor" }, { type: "click" }, { type: "press", selector: "#x" }, { type: "type", selector: "#x", text: 3 }]) assert.throws(() => validateOperation(value));
  assert.deepEqual(validateOperation({ type: "type", selector: "#x", text: "" }), { type: "type", selector: "#x", text: "" });
});

test("every input event is settle-waited; a navigation lands a page capture with its record beside it", async (t) => {
  const { workspace, call, events } = await setup(t);
  const nav = await call({ type: "navigate", url: "https://example.test/start" });
  assert.equal(nav.code, 0, nav.stderr);
  const navResult = JSON.parse(nav.stdout).result;
  assert.equal(navResult.settled.navigated, true);
  assert.deepEqual([navResult.settled.loaded, navResult.settled.networkIdle, navResult.settled.fontsReady, navResult.settled.timedOut], [true, true, true, false]);
  assert.equal(navResult.settled.url, "https://example.test/start");
  assert.equal(navResult.landing.kind, "landing"); assert.equal(navResult.landing.name, "navigate"); assert.equal(navResult.landing.seq, 1);
  assert.match(navResult.landing.file, /^c000001-\d{8}T\d{6}\.\d{3}Z-landing-navigate\.png$/);
  const dir = join(workspace, "browser-captures");
  assert.equal((await readFile(join(dir, navResult.landing.file))).toString(), "PNGhttps://example.test/start0");
  const record = JSON.parse(await readFile(join(dir, navResult.landing.record), "utf8"));
  assert.equal(record.sha256, navResult.landing.sha256); assert.equal(record.kind, "landing");
  assert.deepEqual(record.operation, { type: "navigate", url: "https://example.test/start" });
  assert.deepEqual(record.console.map((line: any) => [line.type, line.text]), [["log", "arrived at https://example.test/start"]]);
  assert.equal(navResult.landing.console, 1);
  // A click that stays on the page settles but lands nothing; one that navigates lands.
  const stay = JSON.parse((await call({ type: "click", selector: "#submit" })).stdout).result;
  assert.equal(stay.settled.navigated, false); assert.equal(stay.landing, null);
  const go = JSON.parse((await call({ type: "click", selector: "#go" })).stdout).result;
  assert.equal(go.settled.navigated, true); assert.equal(go.landing.seq, 2); assert.equal(go.landing.name, "click");
  assert.equal(go.landing.url, "https://example.test/after-click");
  // The wait order per event: load only after a navigation, network idle always.
  const waits = (await events()).filter((event) => event.event === "wait").map((event) => event.state);
  assert.deepEqual(waits, ["load", "networkidle", "networkidle", "load", "networkidle"]);
  // Reads capture nothing and wait for nothing.
  const read = await call({ type: "read", selector: "body" });
  assert.equal(read.code, 0); assert.equal((await events()).filter((event) => event.event === "wait").length, 5);
});

test("a snapshot captures the settled page on demand and carries the console lines since the last capture, page errors included", async (t) => {
  const { workspace, call } = await setup(t);
  await call({ type: "navigate", url: "https://example.test/form" });
  await call({ type: "click", selector: "#boom" });
  const bad = await call({ type: "snapshot", name: "../escape" });
  assert.equal(bad.code, 1); assert.match(bad.stderr, /Invalid name/);
  const shot = await call({ type: "snapshot", name: "after-error" });
  assert.equal(shot.code, 0, shot.stderr);
  const { settled, capture } = JSON.parse(shot.stdout).result;
  assert.equal(settled.navigated, false);
  assert.equal(capture.kind, "snapshot"); assert.equal(capture.name, "after-error"); assert.equal(capture.seq, 2);
  assert.equal(capture.console, 1); assert.equal(capture.errors, 1);
  const record = JSON.parse(await readFile(join(workspace, "browser-captures", capture.record), "utf8"));
  assert.deepEqual(record.console.map((line: any) => [line.type, line.text]), [["pageerror", "fake page error"]]);
  assert.deepEqual(record.operation, { type: "snapshot", name: "after-error" });
  const unnamed = JSON.parse((await call({ type: "snapshot" })).stdout).result.capture;
  assert.equal(unnamed.name, "snapshot"); assert.equal(unnamed.console, 0);
});

test("a page that never goes idle is captured as it is, with the settle facts saying so", async (t) => {
  const f = await setup(t, false);
  await writeFile(f.config, JSON.stringify({ stateDir: f.stateDir, workspace: f.workspace, playwrightModule: f.module, settleTimeoutMs: 300 }));
  assert.equal((await cli(f.entry, "start", f.config)).code, 0);
  const started = Date.now();
  const result = JSON.parse((await f.call({ type: "navigate", url: "https://example.test/never-idle" })).stdout).result;
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.settled.networkIdle, false); assert.equal(result.settled.timedOut, true); assert.equal(result.settled.loaded, true);
  assert.equal(result.landing.kind, "landing");
});

test("the settle wait never outlives the operation deadline", async (t) => {
  const f = await setup(t);
  const started = Date.now();
  const result = await f.call({ type: "navigate", url: "https://example.test/never-idle" }, 1500);
  assert.ok(Date.now() - started < 5000);
  // The default five-second settle bound is cut to what the 1.5 s deadline leaves after the capture's allowance; the page is captured as it is.
  assert.equal(result.code, 0, result.stderr);
  const { settled, landing } = JSON.parse(result.stdout).result;
  assert.equal(settled.networkIdle, false); assert.equal(settled.timedOut, true); assert.equal(landing.kind, "landing");
});

test("a capture failure after dispatch is an error that says the input was sent", async (t) => {
  const { stateDir, call } = await setup(t);
  const failed = await call({ type: "navigate", url: "https://example.test/no-shot" });
  assert.equal(failed.code, 1); assert.match(failed.stderr, /fake screenshot failed/);
  const response = await raw(stateDir, { type: "navigate", url: "https://example.test/no-shot" });
  assert.equal(response.status, 400); assert.equal(response.data.dispatched, true);
  assert.match(response.data.error, /context closed; next operation uses a fresh page/);
  const refused = await raw(stateDir, { type: "navigate", url: "javascript:alert(1)" });
  assert.equal(refused.status, 400); assert.equal(refused.data.dispatched, false);
});

test("captures must live inside the workspace; settle limits are bounded", async (t) => {
  const { root, workspace, entry, config, module, stateDir } = await setup(t, false);
  for (const captureDir of [root, join(root, "elsewhere"), resolve(workspace, "..")]) {
    await writeFile(config, JSON.stringify({ stateDir, workspace, playwrightModule: module, captureDir }));
    const result = await cli(entry, "start", config);
    assert.equal(result.code, 1, captureDir); assert.match(result.stderr, /inside the workspace/);
  }
  await writeFile(config, JSON.stringify({ stateDir, workspace, playwrightModule: module, settleTimeoutMs: 60001 }));
  const tooLong = await cli(entry, "start", config);
  assert.equal(tooLong.code, 1); assert.match(tooLong.stderr, /settleTimeoutMs/);
  await writeFile(config, JSON.stringify({ stateDir, workspace, playwrightModule: module, captureDir: join(workspace, "evidence", "pages") }));
  assert.equal((await cli(entry, "start", config)).code, 0);
  const result = JSON.parse((await cli(entry, "call", stateDir, JSON.stringify({ type: "navigate", url: "https://example.test/x" }))).stdout).result;
  assert.equal((await readFile(join(workspace, "evidence", "pages", result.landing.file))).length > 0, true);
});
