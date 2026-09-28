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

// The page's only script is its arrow-key navigation, admitted by the policy's hash.
function withoutKeyScript(html: string) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, "the page has exactly one script");
  const hash = createHash("sha256").update(scripts[0]![1]!).digest("base64");
  assert.ok(html.includes(`script-src 'sha256-${hash}';`), "the policy admits the script by its hash only");
  assert.doesNotMatch(html, /script-src[^;]*unsafe/);
  return html.replace(scripts[0]![0], "");
}

test("delivers capture-classified package; all originals, viewer, summary, and extractions are checksummed", async t => {
  const { root } = await fixture(t);
  const original = await readFile(join(root, "state/journal/events.jsonl"));
  const delivered = await deliverPackage(root, options);
  assert.equal(delivered.deliveryVerified, true);
  assert.equal(delivered.snapshots, "complete");
  assert.equal(delivered.execution, "passed");
  assert.equal('humanReview' in delivered, false, 'the relay performs no human review');
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
  // Without steps with errors there is nothing to focus on, so the checkbox is not rendered.
  assert.doesNotMatch(html, /id="focus-errors"/);
  assert.doesNotMatch(withoutKeyScript(html), /<script|https?:\/\/|fetch\(/);
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

test("verification accepts a package delivered with the former fixed human review field", async t => {
  const { root } = await fixture(t);
  const delivered = await deliverPackage(root, options);
  const summary = JSON.parse(await readFile(join(root, "summary.json"), "utf8"));
  assert.equal("humanReview" in summary, false);
  const legacy = Buffer.from(JSON.stringify({ formatVersion: summary.formatVersion, packageId: summary.packageId, sessionId: summary.sessionId, taskId: summary.taskId,
    snapshots: summary.snapshots, execution: summary.execution, humanReview: "pending", findings: summary.findings }, null, 2) + "\n");
  await writeFile(join(root, "summary.json"), legacy);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  Object.assign(manifest.records.find((r: any) => r.path === "summary.json"), { sha256: createHash("sha256").update(legacy).digest("hex"), bytes: legacy.length });
  await save(root, "manifest.json", manifest);
  assert.deepEqual(await verifyDeliveredPackage(root), delivered);
});

test('pre-stage diagnostic repair is visible as command-only evidence without fabricated screenshots', async t => {
  const { root } = await fixture(t);
  await save(root, 'host/diagnostics/repair.request.json', { executionId: 'repair', evidenceMode: 'diagnostic', because: 'Repair capture service', argv: ['repair'], step: { title: 'Repair capture', expected: 'Capture works' } });
  await save(root, 'host/diagnostics/repair.receipt.json', { executionId: 'repair', evidenceMode: 'diagnostic', outcome: { kind: 'completed', exitStatus: { code: 0, signal: null } }, stdout: 'repaired', timeoutMs: 120000 });
  const result = await deliverPackage(root, options);
  assert.equal(result.deliveryVerified, true); assert.equal(result.snapshots, 'incomplete');
  const html = await readFile(join(root, 'index.html'), 'utf8');
  // Each verdict that is not complete or passed explains itself, and names the step that caused it.
  assert.match(html, /<button type="button" popovertarget="why-snapshots" title="Why snapshots are incomplete">/);
  assert.match(html, /<div class="why" id="why-snapshots" popover><h3>Why snapshots are incomplete<\/h3><ul class="reasons"><li><p>This diagnostic command ran without screenshots, as diagnostics do\./);
  assert.match(html, /<div class="why" id="why-execution" popover><h3>Why execution is uncertain<\/h3><ul class="reasons"><li><p>Snapshot evidence is incomplete, so the relay does not confirm the run as a whole/);
  const repair = html.split('<article id="step-diagnostic-repair"')[1]!.split('</article>')[0]!;
  assert.match(repair, /<section class="concern"><h3>Why this step affects the verdicts<\/h3><ul><li><span class="label">Snapshots incomplete<\/span><p>This diagnostic command ran without screenshots/);
  assert.doesNotMatch(html, /Human review|>Review</);
  const walk = JSON.parse(await readFile(join(root, 'trajectory.json'), 'utf8'));
  const step = walk.steps.find((s: any) => s.inputMode === 'diagnostic');
  assert.equal(step.title, 'Repair capture'); assert.match(step.observed, /No screenshot evidence/); assert.equal(step.snapshots, undefined);
  assert.equal((await verifyDeliveredPackage(root)).deliveryVerified, true);
});

test("review page orders steps by time and reads commands, exit status, output streams and declared outputs", async t => {
  const { root } = await fixture(t);
  await save(root, "host/diagnostics/early.request.json", { executionId: "early", evidenceMode: "diagnostic", at: "2026-09-12T23:59:00.000Z", because: "Inspect the guest before acting", argv: ["/bin/zsh", "-c", "ls -la workspace"] });
  await save(root, "host/diagnostics/early.receipt.json", { executionId: "early", evidenceMode: "diagnostic", outcome: { kind: "completed", exitStatus: { code: 3, signal: null } }, stdout: "listing", stderr: "denied", timeoutMs: 1000 });
  await save(root, "extractions/evidence/run-1/result.json", { passed: false });
  await save(root, "extractions/evidence/run-1/big.log", "x".repeat(256 * 1024 + 1));
  await save(root, "extractions/evidence/run-1/trace.txt", "\nfirst <line>\n");
  await deliverPackage(root, options);
  const html = await readFile(join(root, "index.html"), "utf8");
  // The diagnostic ran first, so it is step 01 even though the trajectory lists actions first.
  assert.ok(html.indexOf('id="step-diagnostic-early"') < html.indexOf('id="step-step-0"'));
  const diagnostic = html.split('<article id="step-diagnostic-early"')[1]!.split("</article>")[0]!;
  // The panel is headed by the step's position and its stable link, with its kind, time and verdict on the line below.
  assert.match(diagnostic, /<div class="stephead"><h2 class="stepno"><span class="n">Step <span class="d">01<\/span><\/span> <span class="of">of <span class="d">02<\/span><\/span><\/h2><a class="permalink" href="#step-diagnostic-early"[^>]*>/);
  assert.match(diagnostic, /<p class="meta"><span>Diagnostic<\/span><time>23:59:00 UTC<\/time><span class="state"><span class="sr">Execution: <\/span><span class="verdict bad">/);
  // The step's name heads its views; the panel beside them carries no heading of its own.
  assert.match(diagnostic, /<h2 class="sname" title="Inspect the guest before acting"><span class="d">01<\/span><span class="h">Inspect the guest before acting<\/span><\/h2>/);
  assert.doesNotMatch(diagnostic.split('<aside class="panel"')[1]!, /Inspect the guest before acting<\/h2>/);
  // A step without snapshots shows its command and output in the viewport, and its exit status in the panel.
  assert.match(diagnostic, /<pre class="term-cmd"><span class="prompt" aria-hidden="true">\$<\/span>\/bin\/zsh -c &#39;ls -la workspace&#39;<\/pre>/);
  assert.match(diagnostic, /<span class="exit bad">exit 3<\/span>/);
  assert.match(diagnostic, /stdout<\/span><pre>listing<\/pre>/);
  assert.match(diagnostic, /stderr<\/span><pre>denied<\/pre>/);
  assert.match(diagnostic, /Screenshots were not requested for this diagnostic/);
  // The trajectory is read view by view: one snapshot, or a command. Without script the selected view is
  // the :target, and the track has a thumbnail per view, grouped by step.
  assert.deepEqual([...html.split('<footer class="track"')[1]!.matchAll(/<a data-t="(\d+)" href="([^"]+)"/g)].map(m => `${m[1]} ${m[2]}`),
    ["0 #step-diagnostic-early--command", "1 #step-step-0--before", "2 #step-step-0--after"]);
  // The top row switches between the trajectory, which starts at the first step, and the overview.
  assert.match(html, /<nav class="tabs mid" aria-label="View"><a class="t-traj" href="#step-diagnostic-early">Trajectory<\/a><a class="t-over" href="#overview">Overview/);
  // The failed diagnostic is the one step with errors: "Focus on errors" counts it and marks its thumbnail and step.
  assert.match(html, /<main class="center"><label class="focus" title="[^"]+"><input type="checkbox" id="focus-errors">Focus on errors<\/label>/);
  assert.match(html, /<article id="step-diagnostic-early" data-first="0" class="step bad err">/);
  assert.match(html, /<li class="bad diagnostic err"><div class="faces"><a data-t="0" href="#step-diagnostic-early--command"/);
  const action = html.split('<article id="step-step-0"')[1]!.split("</article>")[0]!;
  // Each view shows one snapshot under the step's name and duration, with a capsule naming the snapshot
  // and its capture time right below it. A step's own fragment selects its first view.
  const before = action.split('id="step-step-0--before"')[1]!.split("</section>")[0]!, after = action.split('id="step-step-0--after"')[1]!.split("</section>")[0]!;
  assert.match(action, /<section class="stage view first" id="step-step-0--before" data-v="1" aria-label="Step 02, before">/);
  assert.match(action, /<section class="stage view" id="step-step-0--after" data-v="2" aria-label="Step 02, after">/);
  assert.match(before, /<div class="solo"><button type="button" class="zoom" popovertarget="lightbox-step-0--before" title="Enlarge the before snapshot"><img alt="Before dispatch snapshot" src="[^"]+"><\/button><\/div>/);
  assert.match(before, /<h2 class="sname" title="[^"]+"><span class="d">02<\/span><span class="h">[^<]+<\/span><span class="took" title="Time from the before snapshot to the after snapshot">\d+\.\d s<\/span><\/h2><div class="solo">/);
  assert.match(before, /<\/div><div class="vlabel"><span class="badge" data-role="before"><span class="role">Before<\/span><time>[^<]+<\/time><\/span><\/div>$/);
  assert.doesNotMatch(action, /class="(pair|seg)"/);
  // Pressing a snapshot opens it in a lightbox, which links to the original. The lightboxes form one
  // sequence in step order, commands included, and each one's arrows name the item before and after it.
  assert.deepEqual([...html.matchAll(/<div class="lightbox" id="([^"]+)" data-step="([^"]+)" popover>/g)].map(m => `${m[1]} ${m[2]}`),
    ["lightbox-diagnostic-early--command step-diagnostic-early--command", "lightbox-step-0--before step-step-0--before", "lightbox-step-0--after step-step-0--after"]);
  assert.match(html, /<div class="lightbox" id="lightbox-step-0--after" data-step="step-step-0--after" popover><div class="lb-body"><img loading="lazy" alt="After dispatch snapshot, enlarged" src="[^"]+"><\/div><button type="button" class="lb-nav prev" popovertarget="lightbox-step-0--before" aria-label="Previous: Step 02 · Before, [^"]+">/);
  assert.match(html, /<p class="lb-cap"><span class="label">Step <span class="d">02<\/span> · After<\/span><time>[^<]+<\/time><a href="[^"]+">Open the original<\/a><button type="button" class="close" popovertarget="lightbox-step-0--after" popovertargetaction="hide" aria-label="Close">/);
  // A lightbox arrow names only the neighbouring item's step and role.
  assert.match(html, /aria-label="Previous: Step 02 · Before, [^"]+"><span class="dir" aria-hidden="true">‹<\/span><span class="role">Step <span class="d">02<\/span> · Before<\/span><\/button>/);
  // A command has a lightbox too, where it reads in larger text.
  assert.match(diagnostic, /<button type="button" class="enlarge" popovertarget="lightbox-diagnostic-early--command" title="Enlarge the command">/);
  assert.match(html, /id="lightbox-diagnostic-early--command" data-step="step-diagnostic-early--command" popover><div class="lb-body"><div class="lb-term"><pre class="lb-cmd">/);
  assert.match(html, /<button type="button" class="lb-nav next" popovertarget="lightbox-step-0--before" aria-label="Next: Step 02 · Before, /);
  // The title is the relay's. The statistics say when the run started in UTC (the Overview adds the year),
  // and, filled in by the page's script, in the reader's time zone.
  assert.match(html, /<h1 title="[^"]+">Relay<\/h1>/);
  assert.match(html, /<li class="at"><time datetime="2026-09-12T23:59:00\.000Z" title="Started [^"]+">Sep 12, 23:59 UTC<\/time><span class="local" hidden><span class="sep" aria-hidden="true">·<\/span><time datetime="2026-09-12T23:59:00\.000Z" data-local title="Started, in your time zone"><\/time><\/span><\/li>/);
  // Beside the verdicts, the Trajectory view lists its keyboard shortcuts.
  assert.match(html, /<ul class="pills"><li class="keys" title="Keyboard shortcuts"><kbd aria-label="Left arrow">←<\/kbd><kbd aria-label="Right arrow">→<\/kbd><span>Steps<\/span><kbd>Space<\/kbd><span>Enlarge<\/span><\/li>/);
  // The overview is one column; the package's identity and files close it.
  assert.doesNotMatch(html.split('id="overview"')[1]!, /<aside/);
  assert.match(html, /<section class="block"><h3>Package<\/h3><div class="package"><dl class="ids">/);
  assert.match(html, /<div><dt>Started<\/dt><dd>Sep 12, 2026, 23:59 UTC<\/dd><\/div><\/dl>/);
  // The viewport's arrows move between views and come in two pairs; "Focus on errors" swaps in the pair
  // that skips to the views of steps with errors.
  assert.match(before, /<a class="arrow prev all" href="#step-diagnostic-early--command" aria-label="Previous: step 01, diagnostic">/);
  assert.match(before, /<a class="arrow prev errs" href="#step-diagnostic-early--command" aria-label="Previous with errors: step 01, diagnostic">/);
  assert.match(before, /<a class="arrow next all" href="#step-step-0--after" aria-label="Next: step 02, after">/);
  assert.doesNotMatch(after, /arrow next/);
  // The panel has no paging; its stable link is an icon on the step's line.
  assert.match(action, /<a class="permalink" href="#step-step-0" title="Stable link to this step" aria-label="Stable link to step 02">/);
  assert.doesNotMatch(html, /class="pager"|Start at step/);
  // A step's caption in the track carries its duration; a diagnostic retains no end time.
  const track = html.split('<footer class="track"')[1]!;
  assert.match(track, /<li class="ok"><div class="faces"><a data-t="1" [^>]+><span class="face"><img [^>]+><span class="role">Before<\/span><\/span><\/a><a data-t="2" [^>]+><span class="face"><img [^>]+><span class="role">After<\/span>/);
  assert.match(track.split('<li class="ok">')[1]!, /<span class="took">\d+\.\d s<\/span><\/span>/);
  assert.doesNotMatch(track.split('<li class="ok">')[0]!, /class="took"/);
  // Small text outputs open in a window that shows them and offers the original for download; larger ones stay links.
  assert.match(html, /<span class="where">evidence<\/span><span class="count">3 files · [^<]+<\/span><\/summary><ul class="flist"><li><a href="extractions\/evidence\/run-1\/big.log">run-1\/big.log<\/a>/);
  const opener = /<li><button type="button" class="fopen" popovertarget="(window-output-\d+)" title="View result.json">run-1\/result.json<\/button><span>/.exec(html);
  assert.ok(opener);
  const window1 = html.split(`<div class="fwin" id="${opener[1]}" data-step="overview" popover aria-label="run-1/result.json">`)[1]!.split('<div class="fwin"')[0]!;
  assert.match(window1, /<span class="fw-note" [^>]+>Formatted<\/span>/);
  assert.match(window1, /<a class="fw-dl" href="extractions\/evidence\/run-1\/result.json" download="result.json" data-raw="\{&quot;passed&quot;:false\}">/);
  assert.ok(window1.includes('<pre class="fw-body">\n{\n  &quot;passed&quot;: false\n}</pre>'));
  const window2 = html.split('aria-label="run-1/trace.txt">')[1]!;
  assert.doesNotMatch(window2.split("</pre>")[0]!, /Formatted|data-raw/);
  assert.ok(window2.includes('<pre class="fw-body">\n\nfirst &lt;line&gt;\n</pre>'));
  assert.doesNotMatch(html, /aria-label="run-1\/big.log"/);
  assert.match(html, /<button type="button" class="fopen" popovertarget="window-output-\d+" title="View app.log">app.log<\/button>/);
  assert.doesNotMatch(withoutKeyScript(html), /<script|https?:\/\/|fetch\(/);
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
  assert.equal('humanReview' in result, false, 'the relay performs no human review');
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
  assert.doesNotMatch(withoutKeyScript(html), /<script/);
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
    assert.match(html, new RegExp(`<span class="t">Click Save</span>(<span class="took">[^<]*</span>)?</span><span class="sr">${expected}</span>`));
    assert.match(html, new RegExp(`Execution: </span><span class="verdict [a-z]+"><i aria-hidden="true"></i>${expected}</span>`));
    assert.doesNotMatch(html, /Execution: <\/span><span class="verdict ok"><i aria-hidden="true"><\/i>completed/);
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
    const article = html.split(`<article id="step-${step.id}"`)[1]!.split("</article>")[0]!;
    assert.match(article, new RegExp(`<h3>Reason</h3><p>Reason${i}</p>`));
    assert.match(article, new RegExp(`<h3>Expected</h3><p>Expected${i}</p>`));
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
