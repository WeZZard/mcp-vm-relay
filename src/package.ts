import { createHash } from "node:crypto";
import { lstat, readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve, parse } from "node:path";
import { buildManifest, buildTrajectory, verifyPackage, type PackageManifest, type ReviewStep, type SnapshotArtifact } from "@wezzard/relay-driver-host-sdk";

export interface DeliverPackageOptions {
  packageId: string;
  sessionId: string;
  taskId: string;
}
export interface DeliveryResult {
  manifestPath: string;
  deliveryVerified: boolean;
  snapshots: "complete" | "incomplete";
  execution: "passed" | "failed" | "uncertain";
  humanReview: "pending";
  findings: string[];
}
type Obj = Record<string, any>;
type Step = ReviewStep & { because?: string; actionId: string; inputMode: string };
type Analysis = {
  snapshots: SnapshotArtifact[];
  steps: Step[];
  incompleteGroups: Set<string>;
  findings: string[];
  completeness: DeliveryResult["snapshots"];
  execution: DeliveryResult["execution"];
};
const generated = new Set(["manifest.json", "summary.json", "trajectory.json", "index.html", "OPENING.txt", "journal/session-events.jsonl"]);
// Packages built before the trajectory rename wrote `walkthrough.json` instead of `trajectory.json`.
// Accept that legacy name when verifying so older delivered evidence packages still validate.
const legacyTrajectoryFile = "walkthrough.json";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function object(value: unknown, label: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${label}`);
  return value as Obj;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid ${label}`);
  return value;
}
/** Strict POSIX package paths: no normalization that could hide traversal. */
function relativePath(value: unknown): string {
  const path = text(value, "package path");
  if (path.includes("\\") || /[\x00-\x1f:#?]/.test(path) || path.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error(`unsafe package path: ${path}`);
  }
  return path;
}
async function rootPath(rootDir: string): Promise<string> {
  const root = resolve(rootDir);
  let current = parse(root).root;
  for (const part of root.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe package directory: ${current}`);
  }
  return root;
}
async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = relativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`symlink in package: ${path}`);
    if (info.isDirectory()) result.push(...await filesUnder(root, path));
    else if (info.isFile() && info.nlink === 1) result.push(path);
    else throw new Error(`non-regular or hard-linked package artifact: ${path}`);
  }
  return result.sort();
}
async function readJson(root: string, path: string): Promise<Obj> {
  return object(JSON.parse(await readFile(join(root, relativePath(path)), "utf8")), path);
}
function snapshotPath(sessionId: string, sn: Obj): string {
  const name = relativePath(sn.fileName);
  if (name.includes("/")) throw new Error("snapshot fileName must be a basename");
  return relativePath(`state/snapshots/${relativePath(sessionId)}/${name}`);
}
function sameRef(ref: Obj, sn: SnapshotArtifact): boolean {
  return ref.sha256 === sn.sha256 && ref.bytes === sn.bytes && ref.role === sn.role &&
    ref.capturedAt === sn.capturedAt && ref.declaredAfterIntervalMs === sn.declaredAfterIntervalMs;
}
function outcomeOf(completion: Obj | undefined, refused: boolean): ReviewStep["execution"] {
  if (refused) return "refused";
  if (!completion) return "incomplete";
  if (completion.state === "uncertain" || !completion.toolOutcome) return "uncertain";
  const outcome = object(completion.toolOutcome, "tool outcome");
  if (outcome.kind === "failure") return "failed";
  if (outcome.kind !== "success") return "uncertain";
  const value = outcome.value;
  if (value && typeof value === "object") {
    if (value.timedOut || value.outputRefused || value.signal || value.exitStatus?.signal) return "failed";
    for (const code of [value.code, value.exitCode, value.exitStatus?.code]) {
      if (typeof code === "number" && code !== 0) return "failed";
      if (code === null) return "uncertain";
    }
  }
  return "completed";
}

// Known refusal/failure wins over uncertainty, just as it does in the aggregate.
// Successful receipts never repair missing or failed subprocess/action evidence.
function receiptOutcome(receipt: Obj): ReviewStep["execution"] {
  const outcome = receipt.outcome;
  if (outcome?.kind === "refused") return "refused";
  if (outcome?.kind !== "completed") return "uncertain";
  const exit = outcome.exitStatus;
  if ((typeof exit?.code === "number" && exit.code !== 0) || exit?.signal) return "failed";
  return Number.isSafeInteger(exit?.code) && exit.code === 0 && exit.signal === null ? "completed" : "uncertain";
}
function reconcileOutcome(original: ReviewStep["execution"], receipts: Obj[]): ReviewStep["execution"] {
  const outcomes = [original, ...receipts.map(receiptOutcome)];
  if (outcomes.includes("refused")) return "refused";
  if (outcomes.includes("failed")) return "failed";
  return original === "completed" && outcomes.includes("uncertain") ? "uncertain" : original;
}

async function analyze(root: string, options: DeliverPackageOptions, files: string[]): Promise<Analysis> {
  text(options.packageId, "packageId"); text(options.sessionId, "sessionId"); text(options.taskId, "taskId");
  relativePath(options.sessionId);
  const journalPath = "state/journal/events.jsonl";
  if (!files.includes(journalPath)) throw new Error("missing original state/journal/events.jsonl");
  const events = (await readFile(join(root, journalPath), "utf8")).split("\n").filter(l => l.trim()).map((l, i) => object(JSON.parse(l), `journal line ${i + 1}`));
  const starts = new Map<string, Obj>(), completions = new Map<string, Obj>(), refusals = new Map<string, Obj>();
  const actionRecords = new Map<string, Obj>();
  const findings: string[] = [];
  // One guest state belongs to one enclosure session; mixed-session state is not silently excluded.
  for (const event of events) {
    if (event.sessionId !== undefined && event.sessionId !== options.sessionId) throw new Error("journal session identity mismatch");
    for (const [kind, map] of [["action-start", starts], ["action-completion", completions], ["action-refusal", refusals]] as const) {
      if (event.kind !== kind) continue;
      const id = text(event.actionId, "actionId");
      if (map.has(id)) throw new Error(`duplicate ${kind}: ${id}`);
      map.set(id, event);
    }
  }
  for (const path of files.filter(p => /^state\/records\/actions?\/[^/]+\.json$/.test(p))) {
    const record = await readJson(root, path), id = text(record.actionId, "action record id");
    if (record.sessionId !== options.sessionId || actionRecords.has(id)) throw new Error(`invalid action record identity: ${id}`);
    actionRecords.set(id, record);
    const start = starts.get(id), completion = completions.get(id);
    if (start && record.attemptId !== start.attemptId) throw new Error(`action attempt mismatch: ${id}`);
    if (completion && record.toolOutcome !== undefined && JSON.stringify(record.toolOutcome) !== JSON.stringify(completion.toolOutcome)) throw new Error(`action outcome disagrees with journal: ${id}`);
    if (!starts.has(id) && !refusals.has(id)) findings.push(`action ${id} has no retained start or refusal`);
  }
  for (const id of completions.keys()) if (!starts.has(id)) throw new Error(`completion references unknown action ${id}`);
  const snapshots: SnapshotArtifact[] = [], byPath = new Map<string, SnapshotArtifact>();
  for (const event of events.filter(e => e.kind === "snapshot-captured")) {
    const id = text(event.actionId, "snapshot actionId"), start = starts.get(id);
    if (!start) throw new Error(`snapshot references unknown action ${id}`);
    if (events.indexOf(event) <= events.indexOf(start) || (completions.has(id) && events.indexOf(event) >= events.indexOf(completions.get(id)!))) throw new Error(`snapshot outside action interval: ${id}`);
    const sn = object(event.snapshot, "captured snapshot"), path = snapshotPath(options.sessionId, sn);
    if (byPath.has(path)) throw new Error(`duplicate snapshot capture: ${path}`);
    if (sn.role !== "before" && sn.role !== "after") throw new Error(`invalid snapshot role: ${path}`);
    if (!/^[a-f0-9]{64}$/.test(sn.sha256) || !Number.isSafeInteger(sn.bytes) || sn.bytes < 0) throw new Error(`invalid capture integrity: ${path}`);
    if (!Number.isFinite(Date.parse(text(sn.capturedAt, "capture timestamp")))) throw new Error(`invalid capture timestamp: ${path}`);
    if (sn.role === "after" && (typeof sn.declaredAfterIntervalMs !== "number" || !Number.isFinite(sn.declaredAfterIntervalMs) || sn.declaredAfterIntervalMs < 0)) throw new Error(`invalid declared after interval: ${path}`);
    const plan = start.snapshotPlan;
    if (!plan || (event.group ?? undefined) !== plan.group?.groupId) throw new Error(`snapshot group/plan mismatch: ${id}`);
    if (event.attemptId !== start.attemptId) throw new Error(`snapshot attempt mismatch: ${id}`);
    if ((sn.role === "before" && !plan.capturesBefore) || (sn.role === "after" && (!plan.capturesAfter || plan.capturesAfter.afterIntervalMs !== sn.declaredAfterIntervalMs))) throw new Error(`snapshot contradicts declared plan: ${id}`);
    if (!files.includes(path)) throw new Error(`missing captured original: ${path}`);
    const bytes = await readFile(join(root, path));
    // buildManifest hashes current bytes, not the capture-time claim. Check that claim FIRST.
    if (bytes.length !== sn.bytes || hash(bytes) !== sn.sha256) throw new Error(`capture integrity mismatch: ${path}`);
    const artifact: SnapshotArtifact = { path, sha256: sn.sha256, bytes: sn.bytes, actionId: id, role: sn.role,
      capturedAt: sn.capturedAt, provenance: "dispatch-captured", ...(event.group ? { groupId: text(event.group, "groupId") } : {}),
      ...(sn.declaredAfterIntervalMs !== undefined ? { declaredAfterIntervalMs: sn.declaredAfterIntervalMs } : {}) };
    snapshots.push(artifact); byPath.set(path, artifact);
  }
  for (const path of files.filter(p => p.startsWith("state/snapshots/") && !p.endsWith(".part"))) {
    if (!byPath.has(path)) throw new Error(`snapshot original has no captured journal record: ${path}`);
  }
  // Both journal snapshot-evidence and materialized action records must cite the exact captures.
  for (const record of [...actionRecords.values(), ...events.filter(e => e.kind === "snapshot-evidence")]) {
    const id = text(record.actionId, "snapshot reference actionId"), start = starts.get(id);
    if (record.snapshots === undefined) continue;
    if (!start || !Array.isArray(record.snapshots)) throw new Error(`invalid snapshot references for ${id}`);
    if ((record.groupId ?? undefined) !== start.snapshotPlan?.group?.groupId || record.snapshotRole !== start.snapshotPlan?.role) throw new Error(`action group reference mismatch: ${id}`);
    const cited = new Set<string>();
    for (const raw of record.snapshots) {
      const ref = object(raw, "snapshot reference"), path = snapshotPath(options.sessionId, ref), sn = byPath.get(path);
      if (!sn || sn.actionId !== id || !sameRef(ref, sn) || cited.has(path)) throw new Error(`invalid action snapshot reference: ${id} -> ${path}`);
      cited.add(path);
    }
    for (const sn of snapshots.filter(s => s.actionId === id)) if (!cited.has(sn.path)) findings.push(`action ${id} is missing reverse snapshot reference ${sn.path}`);
  }
  const groups = new Map<string, Obj[]>();
  for (const start of starts.values()) {
    const plan = start.snapshotPlan;
    if (plan?.group) {
      const id = text(plan.group.groupId, "group identity");
      groups.set(id, [...(groups.get(id) ?? []), start]);
    }
  }
  const incompleteGroups = new Set<string>();
  for (const [id, members] of groups) {
    const pair = snapshots.filter(s => s.groupId === id);
    const roles = members.map(m => m.snapshotPlan.role);
    const invalid = roles[0] !== "first" || roles.at(-1) !== "last" || roles.slice(1, -1).some(r => r !== "member") || members.length < 2 || new Set(members.map(m => m.attemptId)).size !== 1;
    const allStarts = [...starts.values()];
    const positions = members.map(m => allStarts.indexOf(m));
    if (invalid || positions.some((p, i) => i > 0 && p !== positions[i - 1]! + 1) || pair.length !== 2 || !pair.some(s => s.role === "before") || !pair.some(s => s.role === "after")) {
      incompleteGroups.add(id); findings.push(`coalescing group ${id} lacks a complete consecutive first/member/last causal pair`);
    }
    if (pair.filter(s => s.role === "before").length > 1 || pair.filter(s => s.role === "after").length > 1) throw new Error(`duplicate group snapshot role: ${id}`);
  }
  // Host routing intent is preserved in full; extract reasons without trusting it as execution proof.
  const hostRecords: Obj[] = events.filter(e => e.kind === "annotation" && e.annotationType === "routing-decision");
  for (const path of files.filter(p => p.startsWith("host/") && /\.jsonl?$/.test(p))) {
    const raw = await readFile(join(root, path), "utf8");
    for (const value of path.endsWith(".jsonl") ? raw.split("\n").filter(l => l.trim()).map(l => JSON.parse(l)) : [JSON.parse(raw)]) {
      if (value && typeof value === "object") hostRecords.push(value);
    }
  }
  // Load authoritative responses before deriving individual review steps. Transport
  // retains both its own verdict and the unmodified receiver frame; neither wins
  // merely because it appears first. Scope by identities, never by reusable step IDs.
  const receipts: Obj[] = [];
  const retainReceipt = (raw: unknown, envelope?: Obj) => {
    const receipt = object(raw, "execution receipt");
    for (const key of ["executionId", "actionId", "sessionId"] as const) {
      if (receipt[key] !== undefined) text(receipt[key], `receipt ${key}`);
      if (envelope?.[key] !== undefined && receipt[key] !== undefined && envelope[key] !== receipt[key]) throw new Error(`receipt ${key} identity mismatch`);
    }
    if (receipt.sessionId !== undefined && receipt.sessionId !== options.sessionId) throw new Error("receipt session identity mismatch");
    const executionId = receipt.executionId ?? envelope?.executionId;
    const actionId = receipt.actionId ?? envelope?.actionId;
    if (executionId === undefined && actionId === undefined) throw new Error("receipt lacks execution/action identity");
    receipts.push({ ...receipt, executionId, actionId });
  };
  for (const event of events.filter(e => e.kind === "execution-completion")) retainReceipt(event.response, event);
  for (const path of files.filter(p => /^(?:host\/(?:receipts|receiver-receipts)|state\/receiver\/receipts)\/[^/]+\.json$/.test(p) || /^host\/diagnostics\/[^/]+\.receipt\.json$/.test(p))) retainReceipt(await readJson(root, path));
  const routingRecords = hostRecords.filter(h => h.because !== undefined || h.request?.because !== undefined || h.step !== undefined || h.request?.step !== undefined);
  const steps: Step[] = [], used = new Set<string>();
  for (const id of new Set([...starts.keys(), ...refusals.keys(), ...actionRecords.keys()])) {
    const start = starts.get(id), record = actionRecords.get(id), refusal = refusals.get(id);
    const source = start ?? refusal ?? record!;
    if (receipts.some(r => r.evidenceMode === 'diagnostic' && r.executionId === (source.executionId ?? record?.executionId))) continue;
    const plan = start?.snapshotPlan, groupId = plan?.group?.groupId;
    const pair = snapshots.filter(s => groupId ? s.groupId === groupId : s.actionId === id);
    if (pair.filter(s => s.role === "before").length > 1 || pair.filter(s => s.role === "after").length > 1) throw new Error(`duplicate action snapshot role: ${id}`);
    const before = pair.find(s => s.role === "before"), after = pair.find(s => s.role === "after");
    if (before && after && (snapshots.indexOf(before) >= snapshots.indexOf(after) || Date.parse(before.capturedAt) > Date.parse(after.capturedAt))) throw new Error(`reversed causal pair: ${id}`);
    const missingPair = !!start && (!plan || !before || !after || (groupId && incompleteGroups.has(groupId)));
    if (missingPair) findings.push(`action ${id} lacks its declared causal pair`);
    if (start && !record) findings.push(`action ${id} has no materialized action record`);
    if (pair.length && (!record?.snapshots || !events.some(e => e.kind === "snapshot-evidence" && e.actionId === id))) findings.push(`action ${id} lacks durable reverse snapshot references`);
    let execution = outcomeOf(completions.get(id), !!refusal || record?.state === "refused");
    if (execution === "completed" && (missingPair || !record || record.state !== "recorded")) execution = "uncertain";
    const rawId = source.stepId ?? record?.stepId ?? id;
    let stepId = text(rawId, "step id");
    if (used.has(stepId)) stepId = `${stepId}@${id}`;
    if (used.has(stepId)) throw new Error(`duplicate review step id: ${stepId}`);
    used.add(stepId);
    const executionId = source.executionId ?? record?.executionId;
    const exactHost = routingRecords.find(h => h.actionId === id || (executionId && (h.executionId === executionId || h.request?.executionId === executionId)));
    const fallback = routingRecords.filter(h => source.stepId && (h.stepId === source.stepId || h.step?.id === source.stepId || h.request?.step?.id === source.stepId));
    // Copies of the same execution's routing metadata are not ambiguous, but
    // different executions sharing a human step ID must never borrow intent.
    const fallbackIdentities = new Set(fallback.map(h => h.executionId ?? h.request?.executionId ?? h.actionId ?? h));
    const candidate = fallbackIdentities.size === 1 ? fallback[0] : undefined;
    const host = exactHost ?? (candidate && (!candidate.actionId || candidate.actionId === id) && (!executionId || !(candidate.executionId ?? candidate.request?.executionId) || (candidate.executionId ?? candidate.request?.executionId) === executionId) ? candidate : undefined);
    const because = source.because ?? host?.because ?? host?.request?.because;
    const actionReceipts = receipts.filter(r => (r.actionId === id || (executionId && r.executionId === executionId)) && (r.actionId === undefined || r.actionId === id) && (r.executionId === undefined || executionId === undefined || r.executionId === executionId));
    execution = reconcileOutcome(execution, actionReceipts);
    const completion = completions.get(id);
    const originalObserved = refusal?.diagnostic ?? completion?.diagnostic ?? (completion?.toolOutcome ? JSON.stringify(completion.toolOutcome) : undefined);
    const observed = actionReceipts.length
      ? `Authoritative receipt outcomes: ${JSON.stringify(actionReceipts.map(r => ({ executionId: r.executionId, actionId: r.actionId, execution: receiptOutcome(r), outcome: r.outcome })))}\nOriginal subprocess/action evidence (not an authoritative input-success verdict): ${JSON.stringify({ refusal: refusal?.diagnostic, state: completion?.state, diagnostic: completion?.diagnostic, toolOutcome: completion?.toolOutcome })}`
      : originalObserved;
    steps.push({ id: stepId, actionId: id, inputMode: source.inputMode ?? record?.inputMode ?? 'unknown', attemptId: source.attemptId ?? "unknown-attempt", title: source.title ?? record?.title ?? id,
      execution, state: record?.state ?? source.state ?? "unknown", expected: host?.step?.expected ?? host?.request?.step?.expected,
      observed,
      ...(typeof because === "string" ? { because } : {}), ...(pair.length ? { snapshots: { before: before?.path, after: after?.path, groupId, declaredAfterIntervalMs: after?.declaredAfterIntervalMs } } : {}) });
  }
  // Diagnostic execution is command evidence, not visual evidence. Include it
  // explicitly rather than hiding setup/repair merely because it has no action pair.
  const diagnostics = new Map<string, Obj>();
  for (const receipt of receipts.filter(r => r.evidenceMode === 'diagnostic')) diagnostics.set(text(receipt.executionId, 'diagnostic execution id'), receipt);
  for (const [executionId, receipt] of diagnostics) {
    const request = hostRecords.find(h => h.executionId === executionId && (h.diagnostic === true || h.evidenceMode === 'diagnostic') && h.argv);
    const stepId = `diagnostic-${executionId}`;
    if (used.has(stepId)) throw new Error(`duplicate diagnostic review step: ${stepId}`);
    used.add(stepId);
    findings.push(`diagnostic ${executionId} has command evidence only; screenshots were not requested`);
    steps.push({ id: stepId, actionId: executionId, inputMode: 'diagnostic', attemptId: request?.attemptId ?? executionId,
      title: request?.step?.title ?? 'Diagnostic command', execution: receiptOutcome(receipt), state: 'diagnostic',
      because: request?.because, expected: request?.step?.expected,
      observed: `No screenshot evidence. ${JSON.stringify({ outcome: receipt.outcome, ...(receipt.output !== undefined ? { output: receipt.output } : { stdout: receipt.stdout, stderr: receipt.stderr }), timeoutMs: receipt.timeoutMs })}` });
  }
  if (events.some(e => ["evidence-failure", "capture-status", "resource-stop"].includes(e.kind) && ["incomplete", "uncertain"].includes(e.state))) findings.push("journal records incomplete evidence or a resource stop");
  if (files.some(p => p.startsWith("state/snapshots/") && p.endsWith(".part"))) findings.push("unfinished snapshot originals retained");
  for (const request of hostRecords.filter(h => typeof h.because === "string" && typeof h.executionId === "string")) {
    if (![...starts.values()].some(s => s.executionId === request.executionId) && !events.some(e => e.kind === "execution-completion" && e.executionId === request.executionId) && !receipts.some(r => r.executionId === request.executionId && r.outcome?.kind === "refused")) {
      findings.push(`request ${request.executionId} has no retained guest execution`);
    }
  }
  const completeness = findings.length ? "incomplete" : "complete";
  const receiptFailed = receipts.some(r => ["refused", "failed"].includes(receiptOutcome(r)));
  const receiptUncertain = receipts.some(r => receiptOutcome(r) === "uncertain");
  const execution = receiptFailed || steps.some(s => s.execution === "failed" || s.execution === "refused") ? "failed" : receiptUncertain || !steps.length || completeness === "incomplete" || steps.some(s => s.execution !== "completed") ? "uncertain" : "passed";
  if (receiptFailed) findings.push("retained execution receipt reports refusal or failure");
  if (receiptUncertain) findings.push("retained execution receipt reports uncertainty");
  return { snapshots, steps, incompleteGroups, findings, completeness, execution };
}

function summary(options: DeliverPackageOptions, a: Analysis) {
  return { formatVersion: 1, ...options, snapshots: a.completeness, execution: a.execution, humanReview: "pending", findings: a.findings };
}
function result(root: string, a: Analysis): DeliveryResult {
  return { manifestPath: join(root, "manifest.json"), deliveryVerified: true, snapshots: a.completeness, execution: a.execution, humanReview: "pending", findings: a.findings };
}
async function buildReview(root: string, a: Analysis) {
  // SDK appends refusal-only steps even when explicit steps were provided.
  // Pass a copy, then retain our complete, unique action/refusal step list.
  const trajectory = await buildTrajectory(root, { steps: [...a.steps], execution: a.execution });
  return { ...trajectory, steps: a.steps, outcomes: { ...trajectory.outcomes, recording: a.completeness } };
}
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function viewer(options: DeliverPackageOptions, a: Analysis): string {
  const link = (step: Step) => `#step-${encodeURIComponent(step.id)}`;
  const image = (path: string | undefined, role: string) => path ? `<figure><figcaption>${role}</figcaption><img alt="${role} dispatch snapshot" src="${escapeHtml(path.split("/").map(encodeURIComponent).join("/"))}"></figure>` : `<p>${role}: unavailable — incomplete evidence</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Relay review: ${escapeHtml(options.packageId)}</title><style>body{font:16px system-ui;margin:2rem;color:#202020;background:#fff}main{display:grid;grid-template-columns:17rem 1fr;gap:2rem}nav{position:sticky;top:1rem;align-self:start}article{border:1px solid #aaa;padding:1rem;margin-bottom:2rem;scroll-margin-top:1rem}article:target{outline:4px solid #258}img{max-width:100%;height:auto}.pair{display:grid;grid-template-columns:1fr 1fr;gap:1rem}figure{margin:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#136} @media(max-width:700px){main,.pair{display:block}nav{position:static}}</style></head><body><h1>${escapeHtml(options.packageId)}</h1><p>Snapshot completeness: ${a.completeness} · Execution: ${a.execution} · Human review: pending</p><p>Delivery integrity is separate from execution success. Snapshots are dispatch-time evidence, not continuous video.</p><main><nav aria-label="Review steps"><ol>${a.steps.map(s => `<li><a href="${escapeHtml(link(s))}">${escapeHtml(s.title)} — ${s.execution}</a></li>`).join("")}</ol><a href="manifest.json">Manifest</a> · <a href="summary.json">Summary</a></nav><section>${a.steps.map((s, i) => `<article id="step-${escapeHtml(s.id)}"><h2>${escapeHtml(s.title)}</h2><p>Execution: ${s.execution} · State: ${escapeHtml(s.state)} · Input mode: ${escapeHtml(s.inputMode)}</p><p>Routing reason: ${escapeHtml(s.because ?? "Not present in retained host metadata")}</p><p>Expected: ${escapeHtml(s.expected ?? "Not supplied")}</p><pre>Observed: ${escapeHtml(s.observed ?? "No confirmed result")}</pre><p>Declared after interval: ${s.snapshots?.declaredAfterIntervalMs ?? "unavailable"} ms${s.snapshots?.groupId ? ` · Group: ${escapeHtml(s.snapshots.groupId)}` : ""}</p><div class="pair">${image(s.snapshots?.before, "Before")}${image(s.snapshots?.after, "After")}</div><p>${i ? `<a href="${escapeHtml(link(a.steps[i - 1]!))}">Previous</a> · ` : ""}<a href="${escapeHtml(link(s))}">Stable link</a>${i + 1 < a.steps.length ? ` · <a href="${escapeHtml(link(a.steps[i + 1]!))}">Next</a>` : ""}</p></article>`).join("")}</section></main></body></html>\n`;
}

/** Assemble already-pulled evidence without rewriting a single guest original. */
export async function deliverPackage(rootDir: string, options: DeliverPackageOptions): Promise<DeliveryResult> {
  const root = await rootPath(rootDir), files = await filesUnder(root);
  if (files.includes("manifest.json")) {
    const existing = await readJson(root, "manifest.json");
    if (existing.packageId !== options.packageId || existing.sessionId !== options.sessionId || existing.taskId !== options.taskId) throw new Error("existing package identity mismatch");
    return verifyDeliveredPackage(root);
  }
  for (const path of files) if (generated.has(path)) throw new Error(`reserved package output already exists: ${path}`);
  const a = await analyze(root, options, files);
  const created: string[] = [];
  const save = async (path: string, contents: string | Buffer) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents, { flag: "wx" });
    created.push(path);
  };
  try {
  // buildTrajectory's SDK layout requires this journal path. Keep its original too.
  await save("journal/session-events.jsonl", await readFile(join(root, "state/journal/events.jsonl")));
  await save("summary.json", json(summary(options, a)));
  await save("index.html", viewer(options, a));
  await save("OPENING.txt", "Open index.html directly in a browser (file://); no server, network, or test machine is required. Select a step or use Previous/Next. Snapshot completeness, execution, and human review are separate. Originals are under state/, host metadata under host/, and declared extractions under extractions/. manifest.json checksums every artifact except itself.\n");
  const build = async () => {
    const all = await filesUnder(root), snapshotPaths = new Set(a.snapshots.map(s => s.path));
    return buildManifest({ ...options, rootDir: root, media: [], segments: [], attempts: [],
      snapshots: a.snapshots.map(s => ({ ...s, absolutePath: join(root, s.path), packagePath: s.path })),
      attachments: all.filter(p => p.startsWith("extractions/")).map(p => ({ absolutePath: join(root, p), packagePath: p, declaredType: "declared-extraction" })),
      records: all.filter(p => p !== "manifest.json" && !snapshotPaths.has(p) && !p.startsWith("extractions/")).map(p => ({ absolutePath: join(root, p), packagePath: p })) });
  };
  await save("manifest.json", json(await build()));
  await save("trajectory.json", json(await buildReview(root, a)));
  await writeFile(join(root, "manifest.json"), json(await build()));
  return await verifyDeliveredPackage(root);
  } catch (error) {
    // Remove only derived files this attempt created, never guest originals.
    // A corrected finish attempt can rebuild after a transient delivery failure.
    for (const path of created.reverse()) await rm(join(root, path), { force: true });
    throw error;
  }
}

/** Revalidate paths BEFORE the SDK verifier opens files; then rederive causal semantics. Throws on corruption. */
export async function verifyDeliveredPackage(rootDir: string): Promise<DeliveryResult> {
  const root = await rootPath(rootDir), files = await filesUnder(root);
  const m = await readJson(root, "manifest.json");
  if (m.manifestVersion !== 1 || !Array.isArray(m.records) || !Array.isArray(m.media) || !Array.isArray(m.attempts) || !Array.isArray(m.segments) || (m.snapshots !== undefined && !Array.isArray(m.snapshots)) || (m.attachments !== undefined && !Array.isArray(m.attachments))) throw new Error("invalid package manifest schema");
  if (m.media.length || m.segments.length || m.attempts.length) throw new Error("mcp-vm-relay snapshot package cannot claim video attempts or segments");
  const manifest = m as PackageManifest;
  const artifacts = [...manifest.records, ...(manifest.snapshots ?? []), ...(manifest.attachments ?? [])], seen = new Set<string>();
  for (const raw of artifacts) {
    const artifact = object(raw, "manifest artifact"), path = relativePath(artifact.path);
    if (path === "manifest.json" || seen.has(path)) throw new Error(`duplicate/self-referential manifest artifact: ${path}`);
    seen.add(path);
    if (!files.includes(path)) throw new Error(`missing artifact: ${path}`);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`invalid manifest integrity metadata: ${path}`);
    const bytes = await readFile(join(root, path));
    if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256) throw new Error(`artifact integrity mismatch: ${path}`);
  }
  for (const path of files) if (path !== "manifest.json" && !seen.has(path)) throw new Error(`unmanifested artifact: ${path}`);
  for (const required of generated) {
    if (required === "manifest.json") continue;
    // A legacy package (pre-trajectory rename) satisfies this requirement with walkthrough.json instead.
    if (required === "trajectory.json" ? !seen.has(required) && !seen.has(legacyTrajectoryFile) : !seen.has(required)) throw new Error(`missing required package output: ${required}`);
  }
  const options = { packageId: manifest.packageId, sessionId: manifest.sessionId, taskId: manifest.taskId };
  const a = await analyze(root, options, files);
  const expectedAttachments = files.filter(p => p.startsWith("extractions/")).sort();
  if (JSON.stringify((manifest.attachments ?? []).map(a => a.path).sort()) !== JSON.stringify(expectedAttachments)) throw new Error("extraction attachment classification mismatch");
  const actualSnapshots = manifest.snapshots ?? [];
  if (actualSnapshots.length !== a.snapshots.length) throw new Error("snapshot manifest classification mismatch");
  for (const sn of a.snapshots) {
    const actual = actualSnapshots.find(s => s.path === sn.path);
    if (!actual || actual.actionId !== sn.actionId || actual.groupId !== sn.groupId || actual.provenance !== "dispatch-captured" || !sameRef(actual, sn)) throw new Error(`snapshot provenance mismatch: ${sn.path}`);
  }
  if (!(await readFile(join(root, "state/journal/events.jsonl"))).equals(await readFile(join(root, "journal/session-events.jsonl")))) throw new Error("trajectory journal differs from original");
  if (await readFile(join(root, "summary.json"), "utf8") !== json(summary(options, a))) throw new Error("summary disagrees with original evidence");
  if (await readFile(join(root, "index.html"), "utf8") !== viewer(options, a)) throw new Error("viewer disagrees with original evidence");
  // A legacy package (pre-trajectory rename) still carries walkthrough.json; read whichever this package actually has.
  const trajectoryFile = !files.includes("trajectory.json") && files.includes(legacyTrajectoryFile) ? legacyTrajectoryFile : "trajectory.json";
  if (await readFile(join(root, trajectoryFile), "utf8") !== json(await buildReview(root, a))) throw new Error("trajectory disagrees with original evidence");
  const acceptance = await verifyPackage(manifest, root);
  // SDK rejects half group pairs categorically. Preserve them as captured snapshots,
  // accepting only this precisely identified incompleteness (never an integrity error).
  const errors = acceptance.findings.filter(f => f.code !== "ok" && !(f.code === "state-inconsistent" && [...a.incompleteGroups].some(g => f.detail === `group ${g} does not carry exactly one before/after pair`)));
  if (errors.length) throw new Error(`package verification failed: ${errors.map(e => e.detail).join("; ")}`);
  return result(root, a);
}
