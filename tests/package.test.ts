import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deliverPackage, verifyDeliveredPackage } from "../src/package.js";

const options = { packageId: "pkg-test", sessionId: "session-test", taskId: "task-test" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function save(root: string, path: string, value: unknown) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
async function fixture(t: test.TestContext, mode: "single" | "group" | "incomplete" | "refused" | "failed" = "single") {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-relay-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events: any[] = [];
  const actions: any[] = [];
  const captures: any[] = [];
  const count = mode === "group" ? 3 : 1;
  for (let i = 0; i < count; i++) {
    const id = `action-${i}`, group = mode === "group" ? "typing" : undefined;
    const role = !group ? "single" : i === 0 ? "first" : i === count - 1 ? "last" : "member";
    const snapshotPlan = { role, capturesBefore: ["single", "first"].includes(role), capturesAfter: ["single", "last"].includes(role) ? { afterIntervalMs: 15 } : false, ...(group ? { group: { groupId: group } } : {}) };
    const common = { sessionId: options.sessionId, attemptId: "attempt-1", actionId: id };
    const refs: any[] = [];
    if (mode === "refused") {
      events.push({ ...common, kind: "action-refusal", state: "refused", diagnostic: "capture unavailable" });
      actions.push({ ...common, state: "refused", title: "Refused click" });
      continue;
    }
    events.push({ ...common, kind: "action-start", state: "admitted", stepId: `step-${i}`, title: `Click ${i}`, executionId: "execution-1", snapshotPlan });
    for (const role of ["before", "after"] as const) {
      if ((role === "before" && !snapshotPlan.capturesBefore) || (role === "after" && (!snapshotPlan.capturesAfter || mode === "incomplete"))) continue;
      const sn = { fileName: `a${i}-${role}.png`, sha256: sha(png), bytes: png.length, role, capturedAt: "2026-09-13T00:00:00.000Z", ...(role === "after" ? { declaredAfterIntervalMs: 15 } : {}) };
      captures.push(sn); refs.push(sn);
      await save(root, `state/snapshots/${options.sessionId}/${sn.fileName}`, png);
      events.push({ ...common, kind: "snapshot-captured", state: "recorded", snapshot: sn, ...(group ? { group } : {}) });
    }
    events.push({ ...common, kind: "snapshot-evidence", snapshots: refs, snapshotRole: role, groupId: group });
    const toolOutcome = { kind: "success", value: { code: mode === "failed" ? 9 : 0, stdout: "saved" } };
    events.push({ ...common, kind: "action-completion", state: "recorded", toolOutcome });
    actions.push({ ...common, state: "recorded", snapshots: refs, snapshotRole: role, groupId: group, toolOutcome });
  }
  await save(root, "state/journal/events.jsonl", events.map((e, i) => JSON.stringify({ ...e, seq: i + 1 })).join("\n") + "\n");
  for (const action of actions) await save(root, `state/records/action/${action.actionId}.json`, action);
  await save(root, "host/routing.json", { executionId: "execution-1", because: "The user is presenting", step: { expected: "Save dialog appears" } });
  await save(root, "extractions/app.log", "retained application log\n");
  return { root, events, actions, captures };
}
async function rewriteJournal(f: Awaited<ReturnType<typeof fixture>>) {
  await save(f.root, "state/journal/events.jsonl", f.events.map(e => JSON.stringify(e)).join("\n") + "\n");
}

test("delivers capture-classified package; all originals, viewer, summary, and extractions are checksummed", async t => {
  const { root } = await fixture(t);
  const original = await readFile(join(root, "state/journal/events.jsonl"));
  const delivered = await deliverPackage(root, options);
  assert.equal(delivered.deliveryVerified, true);
  assert.equal(delivered.snapshots, "complete");
  assert.equal(delivered.execution, "passed");
  assert.equal(delivered.humanReview, "pending");
  const manifest = JSON.parse(await readFile(delivered.manifestPath, "utf8"));
  assert.equal(manifest.snapshots.length, 2);
  assert.ok(manifest.snapshots.every((s: any) => s.provenance === "dispatch-captured" && s.actionId === "action-0"));
  assert.equal(manifest.attachments[0].path, "extractions/app.log");
  for (const path of ["index.html", "summary.json", "trajectory.json", "OPENING.txt", "state/journal/events.jsonl", "host/routing.json", "state/records/action/action-0.json"]) assert.ok(manifest.records.some((r: any) => r.path === path), path);
  assert.deepEqual(await readFile(join(root, "state/journal/events.jsonl")), original);
  assert.deepEqual(await verifyDeliveredPackage(root), delivered);
  const html = await readFile(join(root, "index.html"), "utf8");
  assert.match(html, /The user is presenting/);
  assert.match(html, /href="#step-step-0"/);
  assert.doesNotMatch(html, /<script|https?:\/\/|fetch\(/);
});

test("verification accepts a legacy package that carries walkthrough.json instead of trajectory.json", async t => {
  const { root } = await fixture(t);
  const delivered = await deliverPackage(root, options);
  const bytes = await readFile(join(root, "trajectory.json"));
  await rm(join(root, "trajectory.json"));
  await save(root, "walkthrough.json", bytes);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  manifest.records.find((r: any) => r.path === "trajectory.json").path = "walkthrough.json";
  await save(root, "manifest.json", manifest);
  assert.deepEqual(await verifyDeliveredPackage(root), delivered);
});

test('pre-stage diagnostic repair is visible as command-only evidence without fabricated screenshots', async t => {
  const { root } = await fixture(t);
  await save(root, 'host/diagnostics/repair.request.json', { executionId: 'repair', evidenceMode: 'diagnostic', because: 'Repair capture service', argv: ['repair'], step: { title: 'Repair capture', expected: 'Capture works' } });
  await save(root, 'host/diagnostics/repair.receipt.json', { executionId: 'repair', evidenceMode: 'diagnostic', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } }, stdout: 'repaired', timeoutMs: 120000 });
  const result = await deliverPackage(root, options);
  assert.equal(result.deliveryVerified, true); assert.equal(result.snapshots, 'incomplete');
  const walk = JSON.parse(await readFile(join(root, 'trajectory.json'), 'utf8'));
  const step = walk.steps.find((s: any) => s.inputMode === 'diagnostic');
  assert.equal(step.title, 'Repair capture'); assert.match(step.observed, /No screenshot evidence/); assert.equal(step.snapshots, undefined);
  assert.equal((await verifyDeliveredPackage(root)).deliveryVerified, true);
});

test("group members each review the shared causal pair", async t => {
  const { root } = await fixture(t, "group");
  const result = await deliverPackage(root, options);
  assert.equal(result.execution, "passed");
  const trajectory = JSON.parse(await readFile(join(root, "trajectory.json"), "utf8"));
  assert.equal(trajectory.steps.length, 3);
  for (const step of trajectory.steps) {
    assert.equal(step.snapshots.groupId, "typing");
    assert.ok(step.snapshots.before.endsWith("a0-before.png"));
    assert.ok(step.snapshots.after.endsWith("a2-after.png"));
  }
});

test("missing after capture is delivered explicitly incomplete and never passed", async t => {
  const { root } = await fixture(t, "incomplete");
  const result = await deliverPackage(root, options);
  assert.equal(result.deliveryVerified, true);
  assert.equal(result.snapshots, "incomplete");
  assert.equal(result.execution, "uncertain");
  assert.equal(result.humanReview, "pending");
});

test("refusal-only and nonzero-exit evidence is never reported as passed", async t => {
  for (const mode of ["refused", "failed"] as const) {
    const { root } = await fixture(t, mode);
    const result = await deliverPackage(root, options);
    assert.equal(result.execution, "failed");
    assert.equal(result.deliveryVerified, true);
    const trajectory = JSON.parse(await readFile(join(root, "trajectory.json"), "utf8"));
    assert.equal(trajectory.steps.length, 1, "refusal-only action is not duplicated by the SDK");
  }
});

test("partial coalescing group preserves classified originals and explicit incomplete status", async t => {
  const f = await fixture(t, "group");
  f.events = f.events.filter(e => e.actionId === "action-0");
  await rewriteJournal(f);
  for (const id of ["action-1", "action-2"]) await rm(join(f.root, `state/records/action/${id}.json`));
  await rm(join(f.root, `state/snapshots/${options.sessionId}/a2-after.png`));
  const result = await deliverPackage(f.root, options);
  assert.equal(result.deliveryVerified, true);
  assert.equal(result.snapshots, "incomplete");
  assert.equal(result.execution, "uncertain");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.snapshots[0].groupId, "typing");
  assert.deepEqual(await verifyDeliveredPackage(f.root), result);
});

test("capture-time hashes and sizes are checked before SDK computes fresh hashes", async t => {
  for (const mode of ["hash", "size"] as const) {
    const f = await fixture(t);
    if (mode === "hash") await save(f.root, `state/snapshots/${options.sessionId}/a0-before.png`, Buffer.from("tampered"));
    else { f.events.find(e => e.kind === "snapshot-captured").snapshot.bytes += 1; await rewriteJournal(f); }
    await assert.rejects(deliverPackage(f.root, options), /capture integrity mismatch/);
    await assert.rejects(readFile(join(f.root, "manifest.json")), { code: "ENOENT" });
  }
});

test("rejects capture path traversal and symlinks before reading evidence", async t => {
  const f = await fixture(t);
  f.events.find(e => e.kind === "snapshot-captured").snapshot.fileName = "../../outside.png";
  await rewriteJournal(f);
  await assert.rejects(deliverPackage(f.root, options), /unsafe package path/);
  const g = await fixture(t);
  await symlink("/etc/passwd", join(g.root, "host", "secret"));
  await assert.rejects(deliverPackage(g.root, options), /symlink/);
});

test("rejects orphan snapshots, cross-action references and capture-plan mismatch", async t => {
  const f = await fixture(t);
  await save(f.root, `state/snapshots/${options.sessionId}/orphan.png`, png);
  await assert.rejects(deliverPackage(f.root, options), /no captured journal record/);
  const g = await fixture(t, "group");
  g.actions[0].snapshots = [g.captures[1]];
  await save(g.root, "state/records/action/action-0.json", g.actions[0]);
  await assert.rejects(deliverPackage(g.root, options), /invalid action snapshot reference/);
  const h = await fixture(t);
  h.events.find(e => e.kind === "snapshot-captured" && e.snapshot.role === "after").snapshot.declaredAfterIntervalMs = 100;
  await rewriteJournal(h);
  await assert.rejects(deliverPackage(h.root, options), /contradicts declared plan/);
});

test("missing reverse reference remains incomplete rather than fabricated success", async t => {
  const f = await fixture(t);
  f.actions[0].snapshots = [];
  await save(f.root, "state/records/action/action-0.json", f.actions[0]);
  const result = await deliverPackage(f.root, options);
  assert.equal(result.execution, "uncertain");
  assert.equal(result.snapshots, "incomplete");
});

test("offline viewer escapes routing reasons, titles and stable identifiers", async t => {
  const f = await fixture(t);
  const attack = '</article><script>alert("bad")</script>';
  f.events.find(e => e.kind === "action-start").title = attack;
  f.events.find(e => e.kind === "action-start").stepId = attack;
  await rewriteJournal(f);
  await save(f.root, "host/routing.json", { executionId: "execution-1", because: attack });
  await deliverPackage(f.root, options);
  const html = await readFile(join(f.root, "index.html"), "utf8");
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /%3Cscript%3E/);
});

test("revalidation rejects tampered bytes, size, traversal, unlisted files and relabeled provenance", async t => {
  for (const mode of ["bytes", "size", "path", "extra", "provenance"] as const) {
    const f = await fixture(t);
    const delivered = await deliverPackage(f.root, options);
    const manifest = JSON.parse(await readFile(delivered.manifestPath, "utf8"));
    if (mode === "bytes") await save(f.root, "summary.json", "{}\n");
    if (mode === "size") { manifest.snapshots[0].bytes++; await save(f.root, "manifest.json", manifest); }
    if (mode === "path") { manifest.records[0].path = "../outside"; await save(f.root, "manifest.json", manifest); }
    if (mode === "extra") await save(f.root, "hidden.js", "evil");
    if (mode === "provenance") { manifest.snapshots[0].actionId = "wrong-action"; await save(f.root, "manifest.json", manifest); }
    await assert.rejects(verifyDeliveredPackage(f.root), /integrity mismatch|unsafe package path|unmanifested artifact|provenance mismatch/);
  }
});

test("journal routing annotations survive without a separate host reason", async t => {
  const f = await fixture(t);
  f.events.unshift({ kind: "annotation", annotationType: "routing-decision", sessionId: options.sessionId, executionId: "execution-1", because: "Journaled foreground interference", step: { expected: "Saved" } });
  await rewriteJournal(f);
  await rm(join(f.root, "host/routing.json"));
  await deliverPackage(f.root, options);
  assert.match(await readFile(join(f.root, "index.html"), "utf8"), /Journaled foreground interference/);
});

test("receiver or transport uncertainty overrides successful action completion", async t => {
  const f = await fixture(t);
  await save(f.root, "host/receipts/execution-1.json", { executionId: "execution-1", outcome: { kind: "uncertain", diagnostic: "connection lost" } });
  const result = await deliverPackage(f.root, options);
  assert.equal(result.execution, "uncertain");
  assert.equal(result.snapshots, "complete");
});

test("revalidation rejects symlink substitution and identity reuse", async t => {
  const f = await fixture(t);
  await deliverPackage(f.root, options);
  await assert.rejects(deliverPackage(f.root, { ...options, taskId: "wrong" }), /identity mismatch/);
  await rm(join(f.root, "extractions/app.log"));
  await symlink("/etc/passwd", join(f.root, "extractions/app.log"));
  await assert.rejects(verifyDeliveredPackage(f.root), /symlink/);
});

test("guest receiver's real SDK journal and action records deliver end-to-end with injected IO", async t => {
  const { receive } = await import("../src/guest/receiver.js");
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-relay-package-sdk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const response = await receive({
    kind: "exec", sessionId: options.sessionId, attemptId: "attempt-1", executionId: "execution-1", argv: ["fake-input"],
    because: "Avoid interrupting the active display", snapshots: { afterIntervalMs: 0 }, step: { id: "click", title: "Click Save", expected: "Saved" },
  }, { root, capture: async path => { await writeFile(path, png); }, dispatch: async () => ({ exitStatus: { code: 0, signal: null }, stdout: "saved" }) });
  assert.equal(response.outcome.kind, "completed");
  const result = await deliverPackage(root, options);
  assert.equal(result.deliveryVerified, true);
  assert.equal(result.execution, "passed");
  const trajectory = JSON.parse(await readFile(join(root, "trajectory.json"), "utf8"));
  assert.equal(trajectory.steps[0].because, "Avoid interrupting the active display");
  assert.equal(trajectory.steps[0].expected, "Saved");
});

async function originalBytes(root: string, prefix = ""): Promise<Map<string, Buffer>> {
  const originals = new Map<string, Buffer>();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) for (const [file, bytes] of await originalBytes(root, path)) originals.set(file, bytes);
    else originals.set(path, await readFile(join(root, path)));
  }
  return originals;
}

for (const scenario of ["driver-refused", "driver-uncertain", "transport-uncertain"] as const) {
  test(`real receiver receipts correct step and viewer: ${scenario}`, async t => {
    const { receive } = await import("../src/guest/receiver.js");
    const root = await mkdtemp(join(await realpath(tmpdir()), "pi-relay-package-receipt-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stdout = scenario === "transport-uncertain" ? "saved" : JSON.stringify({ code: scenario === "driver-refused" ? "desktop_escalation_required" : "driver_unknown_error" });
    const subprocess = { exitStatus: { code: 0, signal: null }, stdout };
    const response = await receive({
      kind: "exec", sessionId: options.sessionId, attemptId: "attempt-1", executionId: "execution-1", argv: ["cua-driver", "call", "click"],
      because: "Retain authoritative driver result", snapshots: { afterIntervalMs: 0 }, step: { id: "click", title: "Click Save", expected: "Saved" },
    }, { root, cuaDriver: "cua-driver", capture: async path => { await writeFile(path, png); }, dispatch: async () => subprocess });
    const expected = scenario === "driver-refused" ? "refused" : "uncertain";
    assert.equal(response.outcome.kind, scenario === "transport-uncertain" ? "completed" : expected);
    if (scenario === "transport-uncertain") {
      // Actual transport layout: original guest frame plus transport verdict.
      await save(root, "host/receiver-receipts/execution-1.json", response);
      await save(root, "host/receipts/execution-1.json", { executionId: "execution-1", outcome: { kind: "uncertain", diagnostic: "connection lost after guest completed" } });
    }
    const originals = await originalBytes(root);
    const journal = originals.get("state/journal/events.jsonl")!.toString("utf8").trim().split("\n").map(l => JSON.parse(l));
    const completion = journal.find(e => e.kind === "action-completion");
    assert.equal(completion.toolOutcome.kind, "success");
    assert.deepEqual(completion.toolOutcome.value, subprocess);
    const result = await deliverPackage(root, options);
    assert.equal(result.execution, expected === "refused" ? "failed" : "uncertain");
    assert.equal(result.snapshots, "complete");
    const trajectory = JSON.parse(await readFile(join(root, "trajectory.json"), "utf8"));
    assert.equal(trajectory.steps.length, 1);
    assert.equal(trajectory.steps[0].execution, expected);
    assert.match(trajectory.steps[0].observed, /Authoritative receipt outcomes:/);
    assert.match(trajectory.steps[0].observed, /Original subprocess\/action evidence \(not an authoritative input-success verdict\):/);
    assert.ok(trajectory.steps[0].observed.includes(JSON.stringify(completion.toolOutcome)));
    const html = await readFile(join(root, "index.html"), "utf8");
    assert.match(html, new RegExp(`Click Save — ${expected}`));
    assert.match(html, new RegExp(`Execution: ${expected} · State:`));
    assert.doesNotMatch(html, /Execution: completed · State:/);
    assert.match(html, /Authoritative receipt outcomes:/);
    if (scenario === "transport-uncertain") assert.match(html, /connection lost after guest completed/);
    for (const [path, bytes] of originals) assert.deepEqual(await readFile(join(root, path)), bytes, `unmodified original: ${path}`);
    assert.deepEqual(await verifyDeliveredPackage(root), result);
  });
}

test("each authoritative receipt source is scoped by execution or action, never step ID", async t => {
  for (const location of ["journal", "host/receipts", "host/receiver-receipts", "state/receiver/receipts"] as const) {
    for (const identity of ["executionId", "actionId"] as const) {
      const f = await fixture(t);
      const receipt = { [identity]: identity === "executionId" ? "execution-1" : "action-0", outcome: { kind: "refused", diagnostic: "authoritative refusal" } };
      if (location === "journal") {
        f.events.push({ kind: "execution-completion", sessionId: options.sessionId, ...receipt, response: receipt });
        await rewriteJournal(f);
      } else await save(f.root, `${location}/verdict.json`, receipt);
      const result = await deliverPackage(f.root, options);
      assert.equal(result.execution, "failed");
      const trajectory = JSON.parse(await readFile(join(f.root, "trajectory.json"), "utf8"));
      assert.equal(trajectory.steps[0].execution, "refused", `${location}, ${identity}`);
    }
  }
  const f = await fixture(t);
  await save(f.root, "host/receipts/unrelated.json", { executionId: "unrelated", stepId: "step-0", outcome: { kind: "refused", diagnostic: "another execution" } });
  assert.equal((await deliverPackage(f.root, options)).execution, "failed");
  const trajectory = JSON.parse(await readFile(join(f.root, "trajectory.json"), "utf8"));
  assert.equal(trajectory.steps[0].execution, "completed");
  assert.doesNotMatch(trajectory.steps[0].observed, /another execution/);
});

test("receipt conflicts prefer known refusal/failure and successful receipts never repair action evidence", async t => {
  for (const kind of ["refused", "failed"] as const) {
    const f = await fixture(t);
    await save(f.root, "host/receipts/uncertain.json", { executionId: "execution-1", outcome: { kind: "uncertain", diagnostic: "transport lost" } });
    await save(f.root, "state/receiver/receipts/verdict.json", { executionId: "execution-1", outcome: kind === "refused" ? { kind, diagnostic: "input refused" } : { kind: "completed", exitStatus: { code: 9, signal: null } } });
    assert.equal((await deliverPackage(f.root, options)).execution, "failed");
    assert.equal(JSON.parse(await readFile(join(f.root, "trajectory.json"), "utf8")).steps[0].execution, kind);
  }
  for (const mode of ["failed", "refused", "incomplete", "missing-completion"] as const) {
    const f = await fixture(t, mode === "missing-completion" ? "single" : mode);
    if (mode === "missing-completion") {
      f.events = f.events.filter(e => e.kind !== "action-completion");
      await rewriteJournal(f);
    }
    await save(f.root, "host/receipts/success.json", { executionId: "execution-1", actionId: "action-0", outcome: { kind: "completed", exitStatus: { code: 0, signal: null } } });
    assert.notEqual((await deliverPackage(f.root, options)).execution, "passed");
    assert.equal(JSON.parse(await readFile(join(f.root, "trajectory.json"), "utf8")).steps[0].execution, mode === "missing-completion" ? "incomplete" : mode === "incomplete" ? "uncertain" : mode);
  }
});

test("malformed receipts fail closed and cannot leave a completed review step", async t => {
  for (const outcome of [undefined, {}, { kind: "alien" }, { kind: "completed" }, { kind: "completed", exitStatus: { code: "0", signal: null } }]) {
    const f = await fixture(t);
    await save(f.root, "host/receipts/verdict.json", { executionId: "execution-1", outcome });
    assert.equal((await deliverPackage(f.root, options)).execution, "uncertain");
    assert.equal(JSON.parse(await readFile(join(f.root, "trajectory.json"), "utf8")).steps[0].execution, "uncertain");
  }
  for (const receipt of [null, {}, { executionId: "execution-1", sessionId: "wrong" }]) {
    const f = await fixture(t);
    await save(f.root, "host/receipts/verdict.json", receipt);
    await assert.rejects(deliverPackage(f.root, options), /invalid|identity/);
  }
  const f = await fixture(t);
  f.events.push({ kind: "execution-completion", executionId: "execution-1", response: { executionId: "wrong", outcome: { kind: "completed", exitStatus: { code: 0, signal: null } } } });
  await rewriteJournal(f);
  await assert.rejects(deliverPackage(f.root, options), /identity mismatch/);
});

test("repeated valid step IDs retain each real receiver execution's reason and expectation", async t => {
  const { receive } = await import("../src/guest/receiver.js");
  const root = await mkdtemp(join(await realpath(tmpdir()), "pi-relay-package-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const i of [1, 2]) {
    const request = {
      kind: "exec", sessionId: options.sessionId, attemptId: "attempt-1", executionId: `execution-${i}`, argv: ["fake-input"],
      because: `Reason${i}`, snapshots: { afterIntervalMs: 0 }, step: { id: "repeated", title: `Click ${i}`, expected: `Expected${i}` },
    };
    assert.equal((await receive(request, { root, capture: async path => { await writeFile(path, png); }, dispatch: async () => ({ exitStatus: { code: 0, signal: null }, stdout: "saved" }) })).outcome.kind, "completed");
    // Mirror the host request copy as well as the receiver's routing annotation.
    await save(root, `host/requests/execution-${i}.json`, request);
  }
  const originals = await originalBytes(root);
  assert.equal((await deliverPackage(root, options)).execution, "passed");
  const trajectory = JSON.parse(await readFile(join(root, "trajectory.json"), "utf8"));
  assert.equal(trajectory.steps.length, 2);
  assert.equal(new Set(trajectory.steps.map((s: any) => s.id)).size, 2);
  assert.equal(trajectory.steps[0].id, "repeated");
  assert.equal(trajectory.steps[1].id, `repeated@${trajectory.steps[1].actionId}`);
  const html = await readFile(join(root, "index.html"), "utf8");
  for (const [index, step] of trajectory.steps.entries()) {
    const i = index + 1;
    assert.equal(step.because, `Reason${i}`);
    assert.equal(step.expected, `Expected${i}`);
    const article = html.split(`<article id="step-${step.id}">`)[1]!.split("</article>")[0]!;
    assert.match(article, new RegExp(`Routing reason: Reason${i}`));
    assert.match(article, new RegExp(`Expected: Expected${i}`));
    assert.doesNotMatch(article, new RegExp(`Reason${3 - i}|Expected${3 - i}`));
  }
  for (const [path, bytes] of originals) assert.deepEqual(await readFile(join(root, path)), bytes, path);
  await verifyDeliveredPackage(root);
});

test("step-only routing fallback rejects ambiguity but accepts one identity and its copies", async t => {
  for (const ambiguous of [false, true]) {
    const f = await fixture(t);
    await rm(join(f.root, "host/routing.json"));
    delete f.events.find(e => e.kind === "action-start").executionId;
    for (const i of [1, 2]) {
      f.events.unshift({ kind: "annotation", annotationType: "routing-decision", sessionId: options.sessionId, executionId: ambiguous ? `execution-${i}` : "execution-1", because: "Fallback reason", step: { id: "step-0", expected: "Fallback expectation" } });
    }
    await rewriteJournal(f);
    await deliverPackage(f.root, options);
    const step = JSON.parse(await readFile(join(f.root, "trajectory.json"), "utf8")).steps[0];
    assert.equal(step.because, ambiguous ? undefined : "Fallback reason");
    assert.equal(step.expected, ambiguous ? undefined : "Fallback expectation");
  }
});

test("revalidation rederives outcomes even when a tampered summary is rehashed", async t => {
  const f = await fixture(t, "incomplete");
  await deliverPackage(f.root, options);
  const manifest = JSON.parse(await readFile(join(f.root, "manifest.json"), "utf8"));
  const summary = JSON.parse(await readFile(join(f.root, "summary.json"), "utf8"));
  summary.execution = "passed";
  const bytes = Buffer.from(JSON.stringify(summary, null, 2) + "\n");
  await save(f.root, "summary.json", bytes);
  Object.assign(manifest.records.find((r: any) => r.path === "summary.json"), { bytes: bytes.length, sha256: sha(bytes) });
  await save(f.root, "manifest.json", manifest);
  await assert.rejects(verifyDeliveredPackage(f.root), /summary disagrees/);
});
