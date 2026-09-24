import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { receive, type GuestRequest, type ReceiveOptions } from "../src/guest/receiver.js";
import { desktopEnvironment, hostRequest, waitForDesktop, parseEnviron, refusedBeforeInput, SOCKET_NAME } from "../src/guest/mcp-host.js";
import { checkArguments } from "../src/json-schema.js";

/**
 * The guest half of relay_run without a VM: the real receiver (admission
 * journal, snapshot pair via a fake capture) dispatches the real bundled
 * `mcp-host.mjs call`, which reaches the real guest MCP host over its Unix
 * socket, which drives SDK fixture servers standing in for the targets.
 */
const host = resolve("dist/mcp-host.mjs");
const fixture = resolve("tests/fixtures/mcp-fixture-server.mjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO/8AAAAASUVORK5CYII=", "base64");

function cli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [host, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject); child.on("close", code => done({ code, stdout, stderr }));
  });
}
async function setup(t: { after(fn: () => Promise<unknown>): void }, start = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-mcp-host-")));
  const stateDir = join(root, "mcp"), outputDir = join(root, "workspace", "relay-run"), log = join(root, "calls.jsonl");
  await mkdir(join(root, "workspace"), { recursive: true });
  const launch = (name: string) => ({ command: process.execPath, args: [fixture, name], cwd: join(root, "workspace"), env: { FIXTURE_LOG: log } });
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ stateDir, outputDir, targets: { cua: launch("cua"), playwright: launch("playwright"), "chrome-devtools": launch("chrome-devtools"), broken: { command: join(root, "missing-server"), args: [] } }, startTimeoutMs: 15000 }));
  t.after(async () => { await cli("stop", stateDir).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  if (start) { const started = await cli("start", config); assert.equal(started.code, 0, started.stderr); }
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const captures: string[] = [];
  const options: ReceiveOptions = { root, mcpHost: host, capture: async out => { captures.push(out); await writeFile(out, png); } };
  let n = 0;
  const run = (target: string, tool: string, args: unknown = {}, timeoutMs = 10000) => receive({
    kind: "exec", executionId: `run-${++n}`, sessionId: "session-test", attemptId: "attempt-test",
    argv: [process.execPath, host, "call", stateDir, target, tool, JSON.stringify(args), String(timeoutMs), "15000"],
    because: `relay ${target}.${tool}`, snapshots: { afterIntervalMs: 0 }, step: { id: `${target}.${tool}-${n}`, title: `${target}.${tool}`, expected: "ok", inputMode: "ordinary" },
    timeoutMs: timeoutMs + 20000,
  } as GuestRequest, options);
  const journal = async () => (await readFile(join(root, "state/journal/events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { root, stateDir, outputDir, config, run, calls, captures, journal };
}

test("a forwarded call is journaled, bracketed by snapshots, and its session persists across calls", async t => {
  const f = await setup(t);
  const first = await f.run("playwright", "increment", { by: 2 });
  assert.equal(first.outcome.kind, "completed");
  assert.deepEqual(first.outcome.kind === "completed" && first.outcome.exitStatus, { code: 0, signal: null });
  const summary = JSON.parse(first.stdout!.trim());
  assert.equal(summary.outcome, "completed"); assert.equal(summary.sent, true);
  assert.match(summary.content[0].text, /^count=2 pid=\d+$/);
  const second = JSON.parse((await f.run("playwright", "increment", { by: 3 })).stdout!.trim());
  assert.match(second.content[0].text, /^count=5 /, "the server process and its state survive between receiver invocations");
  assert.equal(second.content[0].text.split("pid=")[1], summary.content[0].text.split("pid=")[1]);
  // A different target is its own server with its own state.
  assert.match(JSON.parse((await f.run("chrome-devtools", "increment")).stdout!.trim()).content[0].text, /^count=1 /);
  assert.equal(first.imageEvidence?.status, "available");
  assert.deepEqual(first.imageEvidence?.snapshots.map(s => s.phase), ["before", "after"]);
  assert.equal(f.captures.length, 6, "two captures per call, taken by the receiver");
  const events = await f.journal();
  const start = events.find(e => e.kind === "execution-start" && e.executionId === "run-1");
  assert.deepEqual(start.argv.slice(2), ["call", f.stateDir, "playwright", "increment", '{"by":2}', "10000", "15000"], "the journal records the exact call");
  assert.ok(events.findIndex(e => e.kind === "snapshot-captured" && e.snapshot.role === "before") < events.indexOf(start) + 3);
  assert.equal((await f.calls()).length, 3);
  // The full result is kept in the output directory for extraction.
  const saved = JSON.parse(await readFile(join(f.outputDir, summary.resultFile), "utf8"));
  assert.equal(saved.content[0].text, summary.content[0].text);
});

test("a target image is written as a file and referenced, never inlined on stdout", async t => {
  const f = await setup(t);
  const result = await f.run("cua", "picture");
  assert.equal(result.outcome.kind, "completed");
  const summary = JSON.parse(result.stdout!.trim());
  assert.equal(summary.content[0].text, "a picture follows");
  const image = summary.content[1];
  assert.equal(image.type, "image"); assert.equal(image.mimeType, "image/png");
  assert.match(image.path, /^cua\/.+\/image-2\.png$/);
  const bytes = await readFile(join(f.outputDir, image.path));
  assert.equal(bytes.length, image.bytes);
  assert.ok(!result.stdout!.includes("iVBOR"), "base64 image bytes never ride on the bounded output");
});

test("isError from the target completes with exit 3; a pre-input refusal is refused", async t => {
  const f = await setup(t);
  const failed = await f.run("playwright", "fail");
  assert.equal(failed.outcome.kind, "completed");
  assert.deepEqual(failed.outcome.kind === "completed" && failed.outcome.exitStatus, { code: 3, signal: null });
  assert.equal(JSON.parse(failed.stdout!.trim()).outcome, "tool-error");
  const refused = await f.run("cua", "escalate");
  assert.equal(refused.outcome.kind, "refused");
  assert.match(refused.outcome.kind === "refused" ? refused.outcome.diagnostic : "", /desktop_escalation_required/);
  assert.equal(refusedBeforeInput({ isError: true, structuredContent: { code: "desktop_escalation_required" } }), true);
  assert.equal(refusedBeforeInput({ isError: true, content: [{ type: "text", text: "desktop_escalation_required" }] }), false, "only the structured code counts");
});

test("arguments that do not match the tool's schema are refused in the guest and never reach the server", async t => {
  const f = await setup(t);
  const refused = await f.run("playwright", "echo", { text: 42 });
  assert.equal(refused.outcome.kind, "refused");
  const summary = JSON.parse(refused.stdout!.trim());
  assert.equal(summary.sent, false); assert.ok(summary.errors.length);
  const unknown = await f.run("playwright", "no_such_tool");
  assert.equal(unknown.outcome.kind, "refused");
  assert.deepEqual((await f.calls()).filter(call => call.tool !== undefined), [], "the server saw no call");
  const ok = JSON.parse((await f.run("playwright", "echo", { text: "hi" })).stdout!.trim());
  assert.equal(ok.content[0].text, "echo:hi"); assert.deepEqual(ok.structuredContent, { echoed: "hi" });
});

test("a server that crashes mid-call is uncertain and not replayed; the next call starts fresh", async t => {
  const f = await setup(t);
  await f.run("playwright", "increment", { by: 5 });
  const crashed = await f.run("playwright", "crash");
  assert.equal(crashed.outcome.kind, "uncertain");
  assert.match(crashed.outcome.kind === "uncertain" ? crashed.outcome.diagnostic : "", /may have acted; it is not replayed/);
  assert.equal((await f.calls()).filter(call => call.tool === "crash").length, 1, "the crashing call was sent exactly once");
  const next = JSON.parse((await f.run("playwright", "increment")).stdout!.trim());
  assert.match(next.content[0].text, /^count=1 /, "a fresh server: the lost state is not silently carried over");
  assert.equal((await f.calls()).filter(call => call.tool === "crash").length, 1, "never replayed");
});

test("a server that died between calls makes the next call refused (not sent)", async t => {
  const f = await setup(t);
  const first = JSON.parse((await f.run("chrome-devtools", "increment")).stdout!.trim());
  process.kill(Number(first.content[0].text.split("pid=")[1]), "SIGKILL");
  await new Promise(done => setTimeout(done, 300));
  const refused = await f.run("chrome-devtools", "increment");
  assert.equal(refused.outcome.kind, "refused");
  assert.match(refused.outcome.kind === "refused" ? refused.outcome.diagnostic : "", /exited .*before this call; nothing was sent/);
  assert.equal((await f.calls()).length, 1);
  assert.equal(JSON.parse((await f.run("chrome-devtools", "increment")).stdout!.trim()).outcome, "completed");
});

test("a call past its timeout is uncertain and the server is stopped", async t => {
  const f = await setup(t);
  const slow = await f.run("playwright", "slow", { ms: 5000 }, 300);
  assert.equal(slow.outcome.kind, "uncertain");
  assert.match(slow.outcome.kind === "uncertain" ? slow.outcome.diagnostic : "", /no answer within 300 ms/);
  const status = await hostRequest(f.stateDir, { op: "status" }, 5000);
  assert.equal(status.targets.playwright.state, "not-started");
});

test("a server that cannot start leaves the call not sent", async t => {
  const f = await setup(t);
  const refused = await f.run("broken", "anything");
  assert.equal(refused.outcome.kind, "refused");
  assert.match(refused.outcome.kind === "refused" ? refused.outcome.diagnostic : "", /did not start/);
});

test("with no host running, the call client reports not sent", async t => {
  const f = await setup(t, false);
  await mkdir(f.stateDir, { recursive: true });
  const refused = await f.run("playwright", "increment");
  assert.equal(refused.outcome.kind, "refused");
  assert.equal(JSON.parse(refused.stdout!.trim()).hostUnavailable, true);
});

test("tools lists the fixture's real tools, the socket is owner-only, and stop removes the host", async t => {
  const f = await setup(t);
  const listed = await cli("tools", f.stateDir, "playwright");
  assert.equal(listed.code, 0, listed.stderr);
  const answer = JSON.parse(listed.stdout);
  const file = JSON.parse(await readFile(answer.file, "utf8"));
  assert.deepEqual(file.tools.map((tool: { name: string }) => tool.name), ["increment", "echo", "picture", "fail", "escalate", "crash", "slow", "huge"]);
  assert.equal((await stat(join(f.stateDir, SOCKET_NAME))).mode & 0o777, 0o600);
  assert.equal((await stat(f.stateDir)).mode & 0o777, 0o700);
  const again = await cli("start", f.config);
  assert.equal(JSON.parse(again.stdout).alreadyRunning, true, "start is idempotent for a live host");
  const stopped = await cli("stop", f.stateDir);
  assert.equal(JSON.parse(stopped.stdout).stopped, true);
  await assert.rejects(stat(join(f.stateDir, "state.json")));
  assert.equal(JSON.parse((await cli("stop", f.stateDir)).stdout).running, false);
});

test("the passthrough text is bounded under the receiver's output limit", async t => {
  const f = await setup(t);
  const result = await f.run("playwright", "huge");
  assert.equal(result.outcome.kind, "completed");
  assert.equal(result.outputTruncated, false);
  const summary = JSON.parse(result.stdout!.trim());
  assert.equal(summary.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout!) < 50 * 1024);
  const full = JSON.parse(await readFile(join(f.outputDir, summary.resultFile), "utf8"));
  assert.equal(full.content[0].text.split("\n").length, 5000, "the result file keeps everything");
  assert.ok((await readdir(join(f.outputDir, "servers"))).includes("playwright.log"));
});

test("argument validation follows the schema's own dialect", () => {
  const draft2020 = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { items: { type: "array", prefixItems: [{ type: "string" }] } }, required: ["items"] };
  assert.deepEqual(checkArguments(draft2020, { items: ["a"] }), { valid: true });
  assert.equal(checkArguments(draft2020, { items: [1] }).valid, false);
  assert.equal(checkArguments({ type: "object", properties: { url: { type: "string", format: "uri" } } }, { url: "not a uri" }).valid, false);
  assert.equal(checkArguments(undefined, {}).valid, false);
});

test("a Linux host under SSH borrows the desktop session's display variables, preferring cua-driver serve", async t => {
  const proc = await mkdtemp(join(tmpdir(), "proc-"));
  t.after(() => rm(proc, { recursive: true, force: true }));
  const fake = async (pid: string, argv: string[], env: Record<string, string>) => {
    await mkdir(join(proc, pid));
    await writeFile(join(proc, pid, "cmdline"), argv.join("\0") + "\0");
    await writeFile(join(proc, pid, "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
  };
  await fake("10", ["/usr/bin/bash"], { HOME: "/home/admin" });
  await fake("11", ["/usr/bin/gnome-shell"], { DISPLAY: ":1", XAUTHORITY: "/other" });
  await fake("12", ["/usr/local/bin/cua-driver", "serve"], { DISPLAY: ":0", XAUTHORITY: "/run/user/1000/gdm/Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_RUNTIME_DIR: "/run/user/1000", XDG_SESSION_TYPE: "x11", SECRET: "not-copied" });
  await writeFile(join(proc, "self"), "");
  assert.deepEqual(parseEnviron(Buffer.from("A=1\0B=x=y\0\0")), { A: "1", B: "x=y" });
  assert.deepEqual(await desktopEnvironment({}, proc, undefined), { DISPLAY: ":0", XAUTHORITY: "/run/user/1000/gdm/Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_RUNTIME_DIR: "/run/user/1000", XDG_SESSION_TYPE: "x11" });
  assert.deepEqual(await desktopEnvironment({ DISPLAY: ":5" }, proc, undefined), {}, "a process that has a display keeps its own");
  await rm(join(proc, "12"), { recursive: true });
  assert.deepEqual(await desktopEnvironment({}, proc, undefined), { DISPLAY: ":1", XAUTHORITY: "/other" }, "any desktop process is the fallback");
  assert.deepEqual(await desktopEnvironment({}, join(proc, "missing"), undefined), {});
});

test("a server started before the desktop login waits for it, within a limit", async t => {
  const proc = await mkdtemp(join(tmpdir(), "proc-"));
  t.after(() => rm(proc, { recursive: true, force: true }));
  const started = Date.now();
  assert.deepEqual(await waitForDesktop({}, 300, proc, undefined), {}, "no session: gives up at the limit");
  assert.ok(Date.now() - started >= 250);
  setTimeout(() => void mkdir(join(proc, "7")).then(() => Promise.all([writeFile(join(proc, "7", "cmdline"), "/usr/bin/gnome-shell\0"), writeFile(join(proc, "7", "environ"), "DISPLAY=:0\0")])), 200);
  assert.deepEqual(await waitForDesktop({}, 5000, proc, undefined), { DISPLAY: ":0" });
});
