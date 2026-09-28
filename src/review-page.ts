// The review page of a delivered evidence package, rendered in the browser by
// the review app (src/review-app/) from the model the review server builds
// out of the package. It is a pure function of that model: it reads no clock,
// no environment and no file. Selection works without script, through links,
// anchors and <details>; the app adds the keys, the lightbox motion, the local
// time and the file windows. The visual design is specified in
// docs/ux-design.md §6.10.

export interface CommandOutput {
  exit?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
}

/** Evidence about a step that the trajectory does not carry as fields. */
export interface StepDetail {
  /** When the step started: the action start, or the diagnostic request. */
  at?: string;
  beforeAt?: string;
  afterAt?: string;
  /** The guest command, exactly as requested. */
  argv?: string[];
  output?: CommandOutput;
}

export interface ReviewPageStep {
  id: string;
  title: string;
  execution: string;
  state: string;
  inputMode: string;
  because?: string;
  expected?: string;
  observed?: string;
  snapshots?: { before?: string; after?: string; groupId?: string; declaredAfterIntervalMs?: number };
}

/** A plain-words reason for a verdict that is not complete or passed, with the steps it concerns. */
export interface Reason { text: string; stepIds: string[] }

export interface ReviewPageModel {
  packageId: string;
  sessionId: string;
  taskId: string;
  completeness: string;
  execution: string;
  findings: string[];
  reasons: { snapshots: Reason[]; execution: Reason[] };
  steps: ReviewPageStep[];
  details: ReadonlyMap<string, StepDetail>;
  /** Declared extractions, by package path. */
  outputs: { path: string; bytes: number }[];
  /** The package's own files the Overview lists, by package path. */
  files: { path: string; bytes: number }[];
}

/** The model as the review server sends it: JSON, with the details keyed by step id. */
export type ReviewData = Omit<ReviewPageModel, "details"> & { details: Record<string, StepDetail> };
export const reviewModelOf = (data: ReviewData): ReviewPageModel => ({ ...data, details: new Map(Object.entries(data.details)) });

/** Files a window can show as text. */
export const textFile = /\.(json|jsonl|ndjson|log|txt|md|csv|tsv|ya?ml|xml|toml)$/i;

export const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const src = (path: string) => escapeHtml(path.split("/").map(encodeURIComponent).join("/"));
const link = (step: ReviewPageStep) => `#step-${encodeURIComponent(step.id)}`;
const time = (iso?: string) => iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(11, 19) : undefined;
const preciseTime = (iso?: string) => iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(11, 23) : undefined;
const duration = (ms: number) => ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 27, 20:08 UTC", or with the year: "Sep 27, 2026, 20:08 UTC". Formatted by hand so the page's bytes do not depend on the ICU build. */
const utcStamp = (iso: string, year = false) => {
  const d = new Date(iso), two = (n: number) => String(n).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${year ? `${d.getUTCFullYear()}, ` : ""}${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
};
/** The relay's mark: two frames, the second stepping in front of the first, for a step's before and after snapshots. */
const relayMark = `<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="3.5" y="4.5" width="11.5" height="9" fill="#336698" stroke="#000" stroke-width="1.2"/><rect x="9" y="10.5" width="11.5" height="9" fill="#fff" stroke="#000" stroke-width="1.2"/><path d="M12 15h5M15.2 13.2l1.8 1.8-1.8 1.8" fill="none" stroke="#cc1b1b" stroke-width="1.8" stroke-linecap="square"/></svg>`;
const size = (bytes: number) => bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes >= 1e3 ? `${(bytes / 1e3).toFixed(1)} kB` : `${bytes} B`;
const noun = (count: number, word: string) => count === 1 ? word : `${word}s`;
const plural = (count: number, word: string) => `${count} ${noun(count, word)}`;
/** A step "has errors" when its execution did not complete: it failed, was refused or is uncertain. */
const erred = (step: ReviewPageStep) => tone(step.execution) !== "ok";
/** Status is carried by one of four tones, and always shown with its word. */
const tone = (value: string) => ["passed", "complete", "completed"].includes(value) ? "ok"
  : ["failed", "refused"].includes(value) ? "bad" : "warn";
const verdict = (value: string) => `<span class="verdict ${tone(value)}"><i aria-hidden="true"></i>${escapeHtml(value)}</span>`;
/** Shell-quote only where needed, so the command reads as it would be typed. */
const shellWord = (word: string) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

// A reviewer reads steps in the order they happened. Steps without a time
// keep their evidence order after the timed ones.
function chronological(model: ReviewPageModel) {
  const at = (step: ReviewPageStep) => Date.parse(model.details.get(step.id)?.at ?? "");
  return model.steps.map((step, index) => ({ step, index }))
    .sort((a, b) => (Number.isFinite(at(a.step)) ? at(a.step) : Infinity) - (Number.isFinite(at(b.step)) ? at(b.step) : Infinity) || a.index - b.index)
    .map(({ step }) => step);
}

// Findings repeat one sentence per identifier; the page states each sentence
// once with a count and lists the identifiers inside it.
function groupFindings(findings: string[]) {
  const groups = new Map<string, { sentence: string; ids: string[] }>();
  for (const finding of findings) {
    const match = /^(diagnostic|request|action) (\S+) (.*)$/.exec(finding);
    const key = match ? `${match[1]} ${match[3]}` : finding;
    const group = groups.get(key) ?? { sentence: finding, ids: [] };
    if (match) group.ids.push(match[2]!);
    groups.set(key, group);
  }
  const sentence = (text: string) => text.replace(/^./, c => c.toUpperCase());
  return [...groups.entries()].map(([key, group]) => {
    if (group.ids.length < 2) return { text: sentence(group.sentence), ids: [] as string[] };
    const [noun, ...rest] = key.split(" ");
    const verb = rest.join(" ").replace(/^has /, "have ").replace(/^is /, "are ").replace(/^lacks /, "lack ");
    return { text: `${group.ids.length} ${noun}s ${verb}`, ids: group.ids };
  });
}

/** How a step reads on the page: a short headline, its kind, and the command it ran if any. */
function describe(step: ReviewPageStep, detail: StepDetail | undefined) {
  const argv = detail?.argv?.length ? detail.argv.map(shellWord).join(" ") : undefined;
  // A generated title ("Diagnostic command", "exec …") says less than the
  // reason the command was sent; the command itself is shown below it.
  const generic = !!argv && (step.title === "Diagnostic command" || step.title.startsWith("exec "));
  const title = generic && step.because ? step.because : step.title;
  // A title that embeds a whole script is cut to its first line; the full
  // title stays on the page as the step's command when no argv was retained.
  const first = title.split("\n")[0]!.trimEnd();
  const headline = first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first === title ? title : `${first} …`;
  const kind = step.inputMode === "diagnostic" ? "Diagnostic" : argv && !step.snapshots ? "Command" : "Action";
  return { headline, command: argv ?? (headline === title ? undefined : title), reasonShown: !(generic && step.because), kind };
}

type Receipt = { execution?: string; outcome?: { kind?: string; exitStatus?: { code?: number | null; signal?: string | null }; diagnostic?: string } };
/** The distinct receipts of an action, from its recorded observation. */
function receipts(observed: string | undefined): Receipt[] | undefined {
  const match = /^Authoritative receipt outcomes: (\[.*\])$/m.exec(observed ?? "");
  if (!match) return undefined;
  try {
    const seen = new Set<string>();
    return (JSON.parse(match[1]!) as Receipt[]).filter(r => {
      const key = JSON.stringify(r);
      return seen.has(key) ? false : (seen.add(key), true);
    });
  } catch {
    return undefined;
  }
}

const exitBadge = (exit: { code?: number | null; signal?: string | null }, timedOut?: boolean) =>
  `<span class="exit ${exit.code === 0 && !timedOut ? "ok" : "bad"}">exit ${escapeHtml(exit.code ?? "none")}${exit.signal ? ` · ${escapeHtml(exit.signal)}` : ""}${timedOut ? " · timed out" : ""}</span>`;

/** The step's observation: a command's exit status and streams, or an action's receipts. */
function observed(step: ReviewPageStep, output: CommandOutput | undefined, streams = true) {
  const recorded = escapeHtml(step.observed ?? "No confirmed result");
  const raw = `<details class="raw"><summary>Receipt as recorded</summary><pre>${recorded}</pre></details>`;
  if (output) {
    const status = output.exit === undefined ? "" : exitBadge({ code: output.exit, signal: output.signal }, output.timedOut);
    const shown = streams ? streamsOf(output) : "";
    return `${status}${shown || (streams ? `<p class="quiet">No output.</p>` : "")}${raw}`;
  }
  const list = receipts(step.observed);
  if (!list?.length) return `<pre class="plain">${recorded}</pre>`;
  return `<ul class="receipts">${list.map(r => `<li>${verdict(r.execution ?? r.outcome?.kind ?? "unknown")}${r.outcome?.exitStatus ? exitBadge(r.outcome.exitStatus) : ""}${r.outcome?.diagnostic ? `<span class="diag">${escapeHtml(r.outcome.diagnostic)}</span>` : ""}</li>`).join("")}</ul>${raw}`;
}

const streamsOf = (output: CommandOutput) => (["stdout", "stderr"] as const).filter(name => output[name]?.trim())
  .map(name => `<div class="stream"><span class="label">${name}</span><pre>${escapeHtml(output[name]!.trimEnd())}</pre></div>`).join("");

/** How long a step took, from its before snapshot to its after snapshot. Diagnostics retain no end time. */
function took(detail: StepDetail | undefined) {
  const ms = Date.parse(detail?.afterAt ?? "") - Date.parse(detail?.beforeAt ?? "");
  return Number.isFinite(ms) && ms >= 0 ? duration(ms) : undefined;
}

const boxId = (step: ReviewPageStep, role: "before" | "after" | "command") => `lightbox-${step.id}--${role}`;
/** A label with its step number set in the monospace face. */
const labelHtml = (label: string) => escapeHtml(label).replace(/^Step (\d+)/, `Step <span class="d">$1</span>`);
const expandIcon = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** One item of a lightbox sequence. `step` is the id of the view it belongs to. */
type Box = { id: string; step: string; label: string; title: string; body: string; caption: string; nav?: string };

// A lightbox shows one item of a sequence at a time: the trajectory's
// snapshots and commands in step order, or the overview's images. Its arrows
// name the previous and next items. Without script each arrow opens the next
// lightbox over the current one; the script replaces the current one instead
// and moves the page to the item's step.
function lightboxes(boxes: Box[]) {
  const nav = (target: Box | undefined, side: "prev" | "next") => target
    ? `<button type="button" class="lb-nav ${side}" popovertarget="${escapeHtml(target.id)}" aria-label="${side === "prev" ? "Previous" : "Next"}: ${escapeHtml(target.label)}, ${escapeHtml(target.title)}"><span class="dir" aria-hidden="true">${side === "prev" ? "‹" : "›"}</span><span class="role">${labelHtml(target.nav ?? target.label)}</span></button>` : "";
  return boxes.map((box, i) => `<div class="lightbox" id="${escapeHtml(box.id)}" data-step="${escapeHtml(box.step)}" popover><div class="lb-body">${box.body}</div>${nav(boxes[i - 1], "prev")}<p class="lb-cap"><span class="label">${labelHtml(box.label)}</span>${box.caption}<button type="button" class="close" popovertarget="${escapeHtml(box.id)}" popovertargetaction="hide" aria-label="Close">×</button></p>${nav(boxes[i + 1], "next")}</div>`).join("\n");
}

/** The trajectory's lightbox sequence: each step's snapshots, or its command. */
function trajectoryBoxes(steps: ReviewPageStep[], model: ReviewPageModel, numbers: Map<string, string>): Box[] {
  return steps.flatMap(step => {
    const detail = model.details.get(step.id), number = numbers.get(step.id)!, { headline, command } = describe(step, detail), view = (role: string) => `step-${step.id}--${role}`;
    if (!step.snapshots) {
      const at = time(detail?.at);
      return [{ id: boxId(step, "command"), step: view("command"), label: `Step ${number} · ${step.inputMode === "diagnostic" ? "Diagnostic" : "Command"}`, title: headline,
        body: `<div class="lb-term"><pre class="lb-cmd"><span class="prompt" aria-hidden="true">$</span>${escapeHtml(command ?? headline)}</pre>${detail?.output ? streamsOf(detail.output) || `<p class="quiet">No output.</p>` : ""}</div>`,
        caption: at ? `<time>${at} UTC</time>` : "" }];
    }
    return (["before", "after"] as const).filter(role => step.snapshots?.[role]).map(role => {
      const path = step.snapshots![role]!, name = role === "before" ? "Before" : "After", at = preciseTime(role === "before" ? detail?.beforeAt : detail?.afterAt);
      return { id: boxId(step, role), step: view(role), label: `Step ${number} · ${name}`, title: headline,
        body: `<img loading="lazy" alt="${name} dispatch snapshot, enlarged" src="${src(path)}">`,
        caption: `${at ? `<time>${at}</time>` : ""}<a href="${src(path)}">Open the original</a>` };
    });
  });
}

/**
 * One view of the viewport: a single snapshot of a step, or its command. The
 * trajectory is read view by view: a step with snapshots has a before view and
 * an after view, and any other step has a command view.
 */
type View = { step: ReviewPageStep; role: "before" | "after" | "command"; id: string; index: number; first: boolean };
function viewsOf(steps: ReviewPageStep[]): View[] {
  const views: View[] = [];
  for (const step of steps) (step.snapshots ? ["before", "after"] as const : ["command"] as const).forEach((role, i) =>
    views.push({ step, role, id: `step-${step.id}--${role}`, index: views.length, first: i === 0 }));
  return views;
}
const viewLink = (view: View) => `#${encodeURIComponent(view.id)}`;
const roleName = (view: View) => view.role === "before" ? "Before" : view.role === "after" ? "After" : view.step.inputMode === "diagnostic" ? "Diagnostic" : "Command";

/** The views around a view: adjacent ones, and the nearest ones of steps with errors. */
type Around = { previous?: View; next?: View; previousError?: View; nextError?: View };

/** A view in the viewport: one snapshot, or the command, with its label and the step's name below it. */
function stage(view: View, detail: StepDetail | undefined, numbers: ReadonlyMap<string, string>, around: Around) {
  const step = view.step, { headline, command } = describe(step, detail), number = numbers.get(step.id)!;
  const numberOf = (target: View) => numbers.get(target.step.id)!;
  // Two pairs of arrows: to the adjacent views, and to the nearest views of
  // steps with errors. "Focus on errors" shows the second pair instead.
  const arrow = (target: View | undefined, side: "prev" | "next", set: "all" | "errs") => target
    ? `<a class="arrow ${side} ${set}" href="${escapeHtml(viewLink(target))}" aria-label="${side === "prev" ? "Previous" : "Next"}${set === "errs" ? " with errors" : ""}: step ${numberOf(target)}, ${roleName(target).toLowerCase()}">${side === "prev" ? "‹" : "›"}</a>` : "";
  const arrows = arrow(around.previous, "prev", "all") + arrow(around.next, "next", "all") + arrow(around.previousError, "prev", "errs") + arrow(around.nextError, "next", "errs");
  const span = took(detail);
  const at = view.role === "command" ? (time(detail?.at) ? `${time(detail?.at)} UTC` : undefined) : preciseTime(view.role === "before" ? detail?.beforeAt : detail?.afterAt);
  // The step's name heads the view, so the panel beside it stays put while
  // the views of one step change; the capsule below names this snapshot.
  const label = `<div class="vlabel"><span class="badge" data-role="${view.role}"><span class="role">${roleName(view)}</span>${at ? `<time>${at}</time>` : ""}</span></div>`;
  const title = `<h2 class="sname" title="${escapeHtml(headline)}"><span class="d">${number}</span><span class="h">${escapeHtml(headline)}</span>${span ? `<span class="took" title="Time from the before snapshot to the after snapshot">${span}</span>` : ""}</h2>`;
  const open = `<section class="stage view${view.role === "command" ? " terminal" : ""}${view.first ? " first" : ""}" id="${escapeHtml(view.id)}" data-v="${view.index}" aria-label="Step ${number}, ${roleName(view).toLowerCase()}">${arrows}${title}`;
  if (view.role === "command") {
    return `${open}<div class="term"><div class="term-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${step.inputMode === "diagnostic" ? "Diagnostic command" : "Command"} · no snapshots</span><button type="button" class="enlarge" popovertarget="${escapeHtml(boxId(step, "command"))}" title="Enlarge the command">${expandIcon}Enlarge</button></div>
<pre class="term-cmd"><span class="prompt" aria-hidden="true">$</span>${escapeHtml(command ?? headline)}</pre>${detail?.output ? streamsOf(detail.output) || `<p class="quiet">No output.</p>` : ""}
<p class="term-note">${step.inputMode === "diagnostic" ? "Screenshots were not requested for this diagnostic." : "No snapshots were captured for this step."}</p></div>${label}</section>`;
  }
  const path = step.snapshots?.[view.role];
  const picture = path
    ? `<button type="button" class="zoom" popovertarget="${escapeHtml(boxId(step, view.role))}" title="Enlarge the ${view.role} snapshot"><img alt="${roleName(view)} dispatch snapshot" src="${src(path)}"></button>`
    : `<div class="void">${roleName(view)}: unavailable — incomplete evidence</div>`;
  return `${open}<div class="solo">${picture}</div>${label}</section>`;
}
/** A reason as it concerns one step: the verdict it affects, and why. */
type Concern = { verdict: string; text: string };

/** The right panel of a step: what it was, why it was sent, and what came back. */
function panel(step: ReviewPageStep, detail: StepDetail | undefined, number: string, total: number, concerns: Concern[]) {
  const { headline, command, reasonShown, kind } = describe(step, detail);
  const interval = step.snapshots?.declaredAfterIntervalMs;
  const at = time(detail?.at);
  const fact = (term: string, value: string) => `<div><dt>${term}</dt><dd>${value}</dd></div>`;
  return `<aside class="panel" aria-label="Step ${number} details"><div class="panel-scroll">
<div class="stephead"><h2 class="stepno"><span class="n">Step <span class="d">${number}</span></span> <span class="of">of <span class="d">${String(total).padStart(2, "0")}</span></span></h2><a class="permalink" href="${escapeHtml(link(step))}" title="Stable link to this step" aria-label="Stable link to step ${number}">${linkIcon}</a></div>
<p class="meta"><span>${kind}</span>${at ? `<time>${at} UTC</time>` : ""}<span class="state"><span class="sr">Execution: </span>${verdict(step.execution)}</span></p>
${concerns.length ? `<section class="concern"><h3>Why this step affects the verdicts</h3><ul>${concerns.map(c => `<li><span class="label">${escapeHtml(c.verdict)}</span><p>${escapeHtml(c.text)}</p></li>`).join("")}</ul></section>` : ""}
${reasonShown ? `<section class="block"><h3>Reason</h3><p>${escapeHtml(step.because ?? "Not present in retained host metadata")}</p></section>` : ""}
${command && step.snapshots ? `<section class="block"><h3>Command</h3><pre class="command">${escapeHtml(command)}</pre></section>` : ""}
<section class="block"><h3>Expected</h3><p>${escapeHtml(step.expected || "Not supplied")}</p></section>
<section class="block"><h3>Observed</h3>${observed(step, detail?.output, !!step.snapshots)}</section>
<dl class="facts">${fact("State", escapeHtml(step.state))}${fact("Input", escapeHtml(step.inputMode))}${fact("After interval", interval === undefined ? "unavailable" : `${interval} ms`)}${took(detail) ? fact("Before to after", took(detail)!) : ""}${step.snapshots?.groupId ? fact("Group", escapeHtml(step.snapshots.groupId)) : ""}</dl>
</div></aside>`;
}

const linkIcon = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M6.6 9.4l2.8-2.8M7.2 4.6l.9-.9a2.8 2.8 0 0 1 4 4l-.9.9M8.8 11.4l-.9.9a2.8 2.8 0 0 1-4-4l.9-.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const downloadIcon = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7.2 8 10.4l3.2-3.2M3 13h10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** One step of the bottom track: a thumbnail per view (before and after, or the command) over the step's caption. */
function thumb(step: ReviewPageStep, detail: StepDetail | undefined, number: string, flagged: boolean, views: View[]) {
  const { headline, command } = describe(step, detail);
  const span = took(detail);
  const faces = views.map((view, i) => {
    const image = view.role === "command" ? undefined : step.snapshots?.[view.role];
    const face = view.role === "command" ? `<pre aria-hidden="true"><span class="prompt">$</span>${escapeHtml(command ?? headline)}</pre>`
      : image ? `<img loading="lazy" alt="" src="${src(image)}">` : `<span class="none">No ${view.role} snapshot</span>`;
    return `<a data-t="${view.index}" href="${escapeHtml(viewLink(view))}" title="${escapeHtml(`Step ${number} · ${roleName(view)} · ${headline}`)}"><span class="face${view.role === "command" ? " text" : ""}">${face}${view.role === "command" ? "" : `<span class="role">${roleName(view)}</span>`}${flagged && i === 0 ? `<span class="flag" title="This step affects the verdicts">!</span>` : ""}</span></a>`;
  }).join("");
  return `<li class="${tone(step.execution)}${step.inputMode === "diagnostic" ? " diagnostic" : ""}${erred(step) ? " err" : ""}"><div class="faces">${faces}</div><span class="cap"><span class="n">${number}</span><i class="dot" aria-hidden="true"></i><span class="t">${escapeHtml(headline)}</span>${span ? `<span class="took">${span}</span>` : ""}</span><span class="sr">${escapeHtml(step.execution)}</span></li>`;
}

// Without script, the selected view is the :target; a step's own fragment
// selects its first view, and no fragment selects the first view of all. Each
// view's index ties it to its thumbnail, and each step's position to its group
// in the track. :has() cannot nest, so a step's own target and a target inside
// it are two selectors.
const selection = (steps: number, firsts: number[], views: number) => !steps ? "" : Array.from({ length: steps }, (_, i) =>
  `.app:has(.center>.step:nth-of-type(${i + 1}):target) .track li:nth-child(${i + 1}),.app:has(.center>.step:nth-of-type(${i + 1}) :target) .track li:nth-child(${i + 1})`).join(",")
  + ",.app:not(:has(.center :target)) .track li:first-child{background:var(--s1)}"
  + [...Array.from({ length: views }, (_, k) => `.app:has([data-v="${k}"]:target) .track [data-t="${k}"] .face`),
    ...firsts.map(k => `.app:has(.center>.step[data-first="${k}"]:target) .track [data-t="${k}"] .face`),
    `.app:not(:has(.center :target)) .track [data-t="0"] .face`].join(",")
  + "{box-shadow:0 0 0 1px var(--ink),0 0 0 4px var(--tab)}";

type FileItem = { href: string; label: string; name: string; bytes: number };
// A file's window is filled by the app when it opens: it reads the file from
// the package and shows its text; the download is the file itself.
function fileWindow(id: string, f: FileItem) {
  const label = escapeHtml(f.label);
  return `<div class="fwin" id="${id}" data-step="overview" data-src="${f.href}" popover aria-label="${label}"><div class="fw-card"><div class="fw-bar"><span class="fw-name" title="${label}">${label}</span>`
    + `<span class="fw-note" title="The download is the original file" hidden>Formatted</span><span class="size">${size(f.bytes)}</span>`
    + `<a class="fw-dl" href="${f.href}" download="${escapeHtml(f.name)}">${downloadIcon}<span>Download</span></a>`
    + `<button type="button" class="close" popovertarget="${id}" popovertargetaction="hide" aria-label="Close">×</button></div>`
    + `<pre class="fw-body"><span class="quiet">Reading the file…</span></pre></div></div>`;
}

/** The page: its title, its body, and the rules that tie each selected view to its thumbnail. */
export function renderReview(model: ReviewPageModel): { title: string; html: string; selection: string } {
  const steps = chronological(model);
  const numbers = new Map(steps.map((step, i) => [step.id, String(i + 1).padStart(2, "0")]));
  const views = viewsOf(steps);
  const times = steps.map(s => Date.parse(model.details.get(s.id)?.at ?? "")).filter(Number.isFinite);
  const diagnostics = steps.filter(s => s.inputMode === "diagnostic").length, actions = steps.length - diagnostics;
  const errors = steps.filter(erred).length;
  const started = times.length ? new Date(Math.min(...times)).toISOString() : undefined;
  const concerns = new Map<string, Concern[]>();
  for (const [key, label] of [["snapshots", `Snapshots ${model.completeness}`], ["execution", `Execution ${model.execution}`]] as const)
    for (const reason of model.reasons[key]) for (const id of reason.stepIds) concerns.set(id, [...(concerns.get(id) ?? []), { verdict: label, text: reason.text }]);
  // extractions/<name>/<transfer id>/…: outputs are grouped by their declared
  // name. The transfer id is the relay's own bookkeeping, so a file reads as
  // its guest path under that name.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const byName = new Map<string, { path: string; bytes: number; label: string }[]>();
  for (const output of model.outputs) {
    const [, declared = "", ...rest] = output.path.split("/");
    byName.set(declared, [...(byName.get(declared) ?? []), { ...output, label: rest.filter(part => !uuid.test(part)).join("/") || output.path.split("/").at(-1)! }]);
  }
  const outputBoxes: Box[] = [], windows: string[] = [];
  const opener = (id: string, f: FileItem) => {
    windows.push(fileWindow(id, f));
    return `<button type="button" class="fopen" popovertarget="${id}" title="View ${escapeHtml(f.name)}">${escapeHtml(f.label)}</button>`;
  };
  // A text output opens in a window; any other output is a link to the file.
  const file = (f: { path: string; bytes: number; label: string }) => !textFile.test(f.path)
    ? `<a href="${src(f.path)}">${escapeHtml(f.label)}</a>`
    : opener(`window-output-${windows.length + 1}`, { href: src(f.path), label: f.label, name: f.label.split("/").at(-1)!, bytes: f.bytes });
  const outputs = [...byName].map(([declared, files]) => {
    const images = files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f.path)), others = files.filter(f => !images.includes(f));
    const total = files.reduce((sum, f) => sum + f.bytes, 0);
    // A long list of outputs folds each declared name; a short one shows everything.
    return `<details class="group"${model.outputs.length <= 12 ? " open" : ""}><summary><span class="where">${escapeHtml(declared)}</span><span class="count">${plural(files.length, "file")} · ${size(total)}</span></summary>${others.length ? `<ul class="flist">${others.map(f => `<li>${file(f)}<span>${size(f.bytes)}</span></li>`).join("")}</ul>` : ""}${images.length ? `<div class="gallery">${images.map(f => {
      const id = `lightbox-output-${outputBoxes.length + 1}`, name = f.label.split("/").at(-1)!;
      outputBoxes.push({ id, step: "overview", label: declared, title: f.label, nav: name, body: `<img loading="lazy" alt="${escapeHtml(f.label)}, enlarged" src="${src(f.path)}">`, caption: `<span class="file">${escapeHtml(f.label)}</span><span class="size">${size(f.bytes)}</span><a href="${src(f.path)}">Open the original</a>` });
      return `<button type="button" class="gthumb" popovertarget="${id}" title="Enlarge ${escapeHtml(name)}"><img loading="lazy" alt="${escapeHtml(f.label)}" src="${src(f.path)}"><span>${escapeHtml(name)}<small>${size(f.bytes)}</small></span></button>`;
    }).join("")}</div>` : ""}</details>`;
  }).join("");
  const notes: Record<string, string> = { "manifest.json": "Checksums of every artifact", "summary.json": "Verdicts and findings", "trajectory.json": "Steps as recorded" };
  const generated = model.files.map(f => `<li>${opener(`window-${f.path.replace(/\W+/g, "-")}`, { href: src(f.path), label: f.path, name: f.path.split("/").at(-1)!, bytes: f.bytes })}${notes[f.path] ? `<span>${notes[f.path]}</span>` : ""}</li>`).join("");
  const stat = (label: string, value: string) => `<li><b>${value}</b>${label ? ` <span>${label}</span>` : ""}</li>`;
  // Reasons with the same words are one reason for all their steps.
  const merged = (reasons: Reason[]) => [...reasons.reduce((all, r) => all.set(r.text, [...new Set([...(all.get(r.text) ?? []), ...r.stepIds])]), new Map<string, string[]>())]
    .map(([text, stepIds]) => ({ text, stepIds }));
  const stepLinks = (ids: string[]) => ids.map(id => `<a href="${escapeHtml(`#step-${encodeURIComponent(id)}`)}">Step <span class="d">${numbers.get(id) ?? "?"}</span></a>`).join("");
  const reasonList = (reasons: Reason[]) => `<ul class="reasons">${merged(reasons).map(r => `<li><p>${escapeHtml(r.text)}</p>${r.stepIds.length ? `<p class="steps">${stepLinks(r.stepIds)}</p>` : ""}</li>`).join("")}</ul>`;
  const why = (key: "snapshots" | "execution", value: string) => key === "snapshots" ? `Why snapshots are ${value}` : value === "failed" ? "Why execution failed" : `Why execution is ${value}`;
  const pill = (key: "snapshots" | "execution", label: string, value: string) => model.reasons[key].length
    ? `<li class="pill ${tone(value)}"><button type="button" popovertarget="why-${key}" title="${why(key, value)}"><span>${label}</span>${verdict(value)}<span class="q" aria-hidden="true">?</span></button><div class="why" id="why-${key}" popover><h3>${why(key, value)}</h3>${reasonList(model.reasons[key])}</div></li>`
    : `<li class="pill ${tone(value)}"><span>${label}</span>${verdict(value)}</li>`;
  const verdictBlock = (key: "snapshots" | "execution", label: string, value: string, fine: string) => `<div class="vblock"><h4>${label} ${verdict(value)}</h4>${model.reasons[key].length ? `<p class="vwhy">${why(key, value)}:</p>${reasonList(model.reasons[key])}` : `<p class="quiet">${fine}</p>`}</div>`;
  const overview = `<article class="step overview" id="overview"><section class="stage doc" aria-label="Package overview"><div class="doc-in">
<h2>Overview</h2><p class="lede">Delivery integrity is separate from execution success. Snapshots are dispatch-time evidence, not continuous video: each shows the screen just before a step was sent and shortly after it returned.</p>
<section class="block"><h3>Verdicts</h3>${verdictBlock("snapshots", "Snapshots", model.completeness, "Every snapshot the steps declared is present and tied to its step.")}${verdictBlock("execution", "Execution", model.execution, "Every step completed, and every retained receipt confirms it.")}</section>
<section class="block"><h3>Findings as recorded <span class="count">${model.findings.length}</span></h3>${model.findings.length ? `<ul class="findings">${groupFindings(model.findings).map(g => `<li>${g.ids.length ? `<details><summary>${escapeHtml(g.text)}</summary><code>${g.ids.map(escapeHtml).join("<br>")}</code></details>` : escapeHtml(g.text)}</li>`).join("")}</ul>` : `<p class="quiet">No findings.</p>`}</section>
<section class="block"><h3>Declared outputs <span class="count">${model.outputs.length}</span></h3>${outputs ? `<div class="outputs">${outputs}</div>` : `<p class="quiet">No declared outputs were delivered.</p>`}</section>
<section class="block"><h3>Package</h3><div class="package"><dl class="ids"><div><dt>Package</dt><dd>${escapeHtml(model.packageId)}</dd></div><div><dt>Task</dt><dd>${escapeHtml(model.taskId)}</dd></div><div><dt>Session</dt><dd>${escapeHtml(model.sessionId)}</dd></div>${started ? `<div><dt>Started</dt><dd>${utcStamp(started, true)}</dd></div>` : ""}</dl>
<ul class="files">${generated}</ul></div></section></div></section></article>`;
  return { title: `Relay review: ${model.packageId}`, selection: selection(steps.length, views.filter(v => v.first).map(v => v.index), views.length), html: `<div class="app">
<header class="top"><div class="brand"><span class="mark" aria-hidden="true">${relayMark}</span><h1 title="${escapeHtml(model.packageId)}">Relay</h1>
<ul class="stats">${stat(noun(steps.length, "step"), String(steps.length))}${stat(noun(actions, "action"), String(actions))}${stat(noun(diagnostics, "diagnostic"), String(diagnostics))}${started ? `<li class="at"><time datetime="${started}" title="Started ${started}">${utcStamp(started)}</time><span class="local" hidden><span class="sep" aria-hidden="true">·</span><time datetime="${started}" data-local title="Started, in your time zone"></time></span></li>` : ""}${times.length ? stat("", duration(Math.max(...times) - Math.min(...times))) : ""}</ul></div>
<nav class="tabs mid" aria-label="View"><a class="t-traj" href="${steps[0] ? escapeHtml(link(steps[0])) : "#"}">Trajectory</a><a class="t-over" href="#overview">Overview<span class="${model.findings.length ? "has" : ""}">${model.findings.length}</span></a></nav>
<ul class="pills"><li class="keys" title="Keyboard shortcuts"><kbd aria-label="Left arrow">←</kbd><kbd aria-label="Right arrow">→</kbd><span>Steps</span><kbd>Space</kbd><span>Enlarge</span></li>${pill("snapshots", "Snapshots", model.completeness)}${pill("execution", "Execution", model.execution)}</ul></header>
<main class="center">${errors ? `<label class="focus" title="Highlight the steps with errors, and move between them with the arrows"><input type="checkbox" id="focus-errors">Focus on errors</label>` : ""}${steps.map(step => {
    const own = views.filter(v => v.step === step);
    return `<article id="step-${escapeHtml(step.id)}" data-first="${own[0]!.index}" class="step ${tone(step.execution)}${erred(step) ? " err" : ""}">${own.map(v => stage(v, model.details.get(step.id), numbers, {
      previous: views[v.index - 1], next: views[v.index + 1], previousError: views.slice(0, v.index).findLast(w => erred(w.step)), nextError: views.slice(v.index + 1).find(w => erred(w.step)) })).join("")}${panel(step, model.details.get(step.id), numbers.get(step.id)!, steps.length, concerns.get(step.id) ?? [])}</article>`;
  }).join("\n")}
${overview}</main>
<footer class="track" aria-label="Steps"><ol>${steps.map(step => thumb(step, model.details.get(step.id), numbers.get(step.id)!, concerns.has(step.id), views.filter(v => v.step === step))).join("")}</ol></footer>
</div>
${lightboxes(trajectoryBoxes(steps, model, numbers))}
${lightboxes(outputBoxes)}${windows.join("")}` };
}

// Design (docs/ux-design.md §6.10): the BeOS palette in the International
// Typographic Style, balanced on the visual centre. The viewport is the
// Be-blue desktop that snapshots sit on; the header, panel and track are
// light-grey chrome with a grey rule over a white highlight; Be-tab yellow
// marks the current tab, the selected thumbnail and window title bars. Status
// is green, amber and red with its word; links are a deep Be blue. Type is
// Swiss 721 (Helvetica), hierarchy by size and weight on a strict grid; views
// are centred just above the middle, with controls placed symmetrically.
export const reviewCss = `:root{color-scheme:light;--bg:#efefef;--s1:#ffffff;--s2:#e2e2e2;--s3:#c8c8c8;--hair:#b4b4b4;--ink:#000000;--text:#000000;--dim:#2e2e2e;--faint:#595959;
--chrome:#d8d8d8;--lo:#989898;--dark:#6c6c6c;--desk:#336698;--tab:#ffcb00;--red:#cc1b1b;--green:#1e8a3c;--amber:#ff9d00;--accent:#1d4f8c;--on:#ffffff;
--ok:var(--green);--bad:var(--red);--warn:#8f5c00;--rule:1px solid var(--hair);--edge:1px solid var(--dark);
--sans:"Swis721 BT","Swiss 721","Helvetica Neue",Helvetica,Arial,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--chrome);color:var(--text);font:14px/1.57 var(--sans);-webkit-font-smoothing:antialiased}
body.runs{background:var(--desk);display:grid;place-content:center;padding:3rem}.runs h1{margin:0;padding:.35rem .9rem;width:max-content;background:var(--tab);border:var(--edge);border-bottom:0;font:700 15px var(--sans)}.runs ul{list-style:none;margin:0;padding:.5rem 1.25rem;min-width:36rem;background:var(--bg);border:var(--edge)}.runs li{padding:.5rem 0;border-bottom:var(--rule);font:14px var(--mono)}.runs li:last-child{border-bottom:0}
.loading{min-height:100vh;margin:0;display:grid;place-items:center;background:var(--desk);font:700 1.5rem/1.2 var(--sans);letter-spacing:-.01em;color:var(--on)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
pre{font:12.5px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
b,time,.n,.exit,dd,.took{font-variant-numeric:tabular-nums}.d{font-family:var(--mono);font-weight:600;letter-spacing:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.label,h3,dt{font:700 11px/1.45 var(--sans);color:var(--text)}
.quiet{color:var(--faint);margin:0}
.ok{--tone:var(--ok)}.bad{--tone:var(--bad)}.warn{--tone:var(--warn)}
.verdict{display:inline-flex;align-items:center;gap:.4rem;font:700 12.5px/1 var(--sans);color:var(--tone,var(--dim));text-transform:capitalize}
.verdict i{flex:none;width:9px;height:9px;border-radius:50%;background:currentColor}
.app{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;grid-template-columns:minmax(0,1fr);overflow:clip}.track{min-width:0;position:relative;z-index:0;display:grid}
.top{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:1rem;padding:.9rem 1.5rem;position:relative;z-index:2;background:var(--chrome);border-bottom:1px solid var(--lo);box-shadow:0 1px 0 var(--on)}
.brand{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:0 .75rem;min-width:0}.brand .mark{grid-row:1/3}.brand h1,.brand .stats{grid-column:2;margin:0}
.mark{flex:none;display:grid;place-items:center;width:2.75rem;height:2.75rem;background:var(--tab);border:var(--edge)}
h1{display:flex;align-items:baseline;gap:.6rem;font:700 1.45rem/1.05 var(--sans);letter-spacing:-.02em;margin:0}
.stats .at time{font:500 12px var(--sans);color:var(--text)}.stats .at .sep{margin:0 .35rem}
.stats{display:flex;gap:.1rem .65rem;list-style:none;margin:.3rem 0 0;padding:0;font-size:12px;color:var(--faint)}.stats b{font:700 12px var(--sans);color:var(--text)}
.pills{min-width:0;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:.4rem;list-style:none;margin:0;padding:0}.pills>li,.stats>li{white-space:nowrap}
.pill{--fill:var(--tone,var(--faint));--pill-ink:var(--on);display:flex;align-items:center;gap:.45rem;padding:.35rem .6rem;background:var(--fill);border:var(--edge);font:500 11.5px var(--sans);color:var(--pill-ink)}.pill.warn{--fill:var(--amber);--pill-ink:var(--ink)}.pill .verdict{color:inherit}
.mid{justify-self:center}
.tabs{display:flex;border:var(--edge)}
.tabs a{display:inline-flex;align-items:center;gap:.45rem;padding:.4rem 1.1rem;background:var(--s2);color:var(--dim);font:700 13px var(--sans)}.tabs a+a{border-left:var(--edge)}.tabs a:hover{text-decoration:none;color:var(--text);background:var(--s1)}
.tabs a span{display:grid;place-items:center;min-width:1.25rem;height:1.25rem;padding:0 .3rem;font:700 11px/1 var(--sans);background:var(--s3);color:var(--dim)}.tabs a span.has{background:var(--desk);color:var(--on)}
.app:not(:has(#overview:target)) .t-traj,.app:has(#overview:target) .t-over{background:var(--tab);color:var(--ink)}
.pill button{all:unset;display:flex;align-items:center;gap:.45rem;cursor:pointer}.pill:has(button){padding-right:.45rem}.pill:has(button):hover{outline:2px solid var(--ink);outline-offset:1px}
.pill button:focus-visible{outline:2px solid var(--accent);outline-offset:6px}
.q{display:grid;place-items:center;width:1.1rem;height:1.1rem;border-radius:50%;background:var(--pill-ink,var(--ink));color:var(--fill,var(--on));font:700 10.5px/1 var(--sans)}
.why{white-space:normal;text-align:left;font:400 14px/1.57 var(--sans);position:fixed;inset:auto;top:4.75rem;right:1.5rem;margin:0;width:min(26rem,calc(100vw - 2rem));max-height:calc(100vh - 6rem);overflow:auto;padding:0 1.25rem 1.25rem;border:var(--edge);background:var(--bg);color:var(--text);box-shadow:3px 3px 0 rgba(0,0,0,.25)}
.why h3{margin:0 -1.25rem 1rem;padding:.45rem 1.25rem;background:var(--tab);border-bottom:var(--edge);font:700 14px/1.3 var(--sans)}
.reasons{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}.reasons li{display:grid;gap:.35rem}.reasons p{margin:0;color:var(--dim);font-size:13.5px;line-height:1.55}
.reasons .steps{display:flex;flex-wrap:wrap;gap:.75rem}.reasons .steps a{font:700 12px var(--sans)}
.concern{margin-top:1.5rem;padding:1rem 1rem 1.1rem;background:#fff4c7;border:var(--edge);border-left:6px solid var(--tab)}.concern h3{margin:0 0 .75rem}
.concern ul{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}.concern li{display:grid;gap:.15rem}.concern p{margin:0;color:var(--text);font-size:14px;line-height:1.55}
.vblock{padding:.75rem 0 1rem;border-top:var(--rule)}
.vblock h4{display:flex;align-items:center;gap:.75rem;margin:0 0 .5rem;font:700 15px var(--sans)}.vwhy{margin:0 0 .5rem;font-size:12.5px;color:var(--faint)}.vblock>.quiet{font-size:13.5px}
.face{position:relative}.flag{position:absolute;top:.3rem;right:.3rem;display:grid;place-items:center;width:1.1rem;height:1.1rem;border-radius:50%;background:var(--amber);color:var(--ink);font:800 11px/1 var(--sans);box-shadow:0 0 0 1px var(--ink)}
.focus{position:absolute;left:1.5rem;bottom:1rem;z-index:4;display:flex;align-items:center;gap:.5rem;padding:.35rem .7rem .35rem .5rem;background:var(--chrome);border:var(--edge);font:700 12.5px var(--sans);color:var(--text);cursor:pointer;user-select:none}
.focus input{appearance:none;margin:0;width:1rem;height:1rem;background:var(--s1);box-shadow:inset 0 0 0 1px var(--dark);display:grid;place-items:center;cursor:pointer}
.focus input:checked{background:var(--red);box-shadow:none}.focus input:checked::after{content:"";width:.28rem;height:.55rem;border:solid #fff;border-width:0 2px 2px 0;rotate:45deg;translate:0 -1px}
.app:has(#focus-errors:checked) .track li:not(.err){opacity:.3;filter:grayscale(1)}
.app:has(#focus-errors:checked) .track li.err .face{box-shadow:0 0 0 3px var(--red)}
.app:has(#focus-errors:checked) .track li.err .t{color:var(--red)}
.app:has(#overview:target) .track{display:none}.app:has(#overview:target) .focus{display:none}.app:has(#overview:target) .keys{display:none}
.keys{display:flex;align-items:center;gap:.2rem;margin-right:.5rem;font-size:11px;color:var(--faint)}.keys span{margin:0 .4rem 0 .1rem}.keys span:last-child{margin-right:0}
kbd{display:inline-grid;place-items:center;min-width:1.35rem;height:1.35rem;padding:0 .3rem;border:var(--edge);background:var(--s1);box-shadow:inset -1px -1px 0 var(--s3);font:600 11px/1 var(--sans);color:var(--text)}.overview>.doc{grid-area:auto;grid-column:1/-1;grid-row:1}
.center{display:grid;grid-template-columns:minmax(0,1fr) minmax(20rem,25rem);grid-template-areas:"stage panel";gap:0;padding:0;min-height:0;position:relative;z-index:1}
.step{display:none}.step:is(:target,:has(:target)){display:contents}.center:not(:has(:target))>.step:first-of-type{display:contents}
.step>.view{display:none}.step>.view:target,.step:target>.view.first,.center:not(:has(:target))>.step:first-of-type>.view.first{display:flex}
.stage{grid-area:stage;position:relative;min-width:0;min-height:0;background:var(--desk);display:grid;grid-template-rows:minmax(0,1fr);overflow:clip}
.view{flex-direction:column;align-items:center;justify-content:center;gap:.75rem;padding:1.5rem 5.25rem 3.5rem}
.solo{flex:0 1 auto;min-height:0;max-width:100%;display:flex;justify-content:center}
.zoom{all:unset;display:flex;min-height:0;max-height:100%;max-width:100%;cursor:zoom-in}.zoom:focus-visible{outline:none}
.solo img{max-width:100%;max-height:100%;object-fit:contain;background:#fff;box-shadow:0 0 0 1px var(--ink),4px 4px 0 rgba(0,0,0,.28);transition:box-shadow .15s}
.zoom:hover img,.zoom:focus-visible img{box-shadow:0 0 0 3px var(--tab),4px 4px 0 rgba(0,0,0,.28)}
.vlabel{display:grid;justify-items:center;gap:.5rem;min-width:0}
.badge{display:inline-flex;align-items:baseline;gap:.75rem;padding:.25rem .65rem;background:var(--chrome);border:var(--edge)}
.badge .role{font:700 12px/1 var(--sans);color:var(--text)}.badge[data-role="after"] .role{color:var(--accent)}.badge time{font:12px/1 var(--mono);color:var(--faint)}
.sname{flex:none;display:flex;align-items:baseline;gap:.75rem;max-width:100%;margin:0;font:700 20px/1.3 var(--sans);letter-spacing:-.015em;color:var(--on)}
.sname .d{flex:none;font:700 20px var(--sans);letter-spacing:-.015em;color:#a9c4e2}.sname .h{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sname .took{flex:none;align-self:center;padding:.2rem .45rem;background:var(--tab);border:var(--edge);font:700 11.5px/1 var(--sans);color:var(--ink)}
.lightbox{position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:1.5rem 1.5rem 1.25rem;border:0;background:none;color:var(--text);overflow:hidden;transition:overlay .36s allow-discrete,display .36s allow-discrete}
.lb-body>*{transform-origin:0 0;transition:transform .36s cubic-bezier(.3,.9,.3,1),opacity .24s ease}
.lightbox:not([data-flip]):not(:popover-open) .lb-body>*{opacity:0}@starting-style{.lightbox:popover-open:not([data-flip]) .lb-body>*{opacity:0}}
.lightbox>:not(.lb-body){translate:0 calc(100% + 2.5rem);transition:translate .36s cubic-bezier(.3,.9,.3,1)}.lightbox:popover-open>:not(.lb-body){translate:0}@starting-style{.lightbox:popover-open>:not(.lb-body){translate:0 calc(100% + 2.5rem)}}
.lightbox{grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;gap:1rem 1.5rem;align-items:center}.lightbox:popover-open{display:grid}
.lightbox::backdrop{background:rgba(35,70,105,0);transition:background .32s ease,overlay .36s allow-discrete,display .36s allow-discrete}
.lightbox:popover-open::backdrop{background:rgba(35,70,105,.97)}@starting-style{.lightbox:popover-open::backdrop{background:rgba(35,70,105,0)}}
.lightbox[data-instant],.lightbox[data-instant]::backdrop,.lightbox[data-instant]>*,.lightbox[data-instant] .lb-body>*{transition:none}
.lb-body{grid-column:1/-1;grid-row:1;display:grid;place-items:center;min-height:0;height:100%;pointer-events:none}.lb-body>*{pointer-events:auto}
.lb-body img{display:block;max-width:100%;max-height:calc(100vh - 7.5rem);object-fit:contain;background:#fff;box-shadow:0 0 0 1px var(--ink),5px 5px 0 rgba(0,0,0,.3)}
.lb-term{width:min(100%,72rem);max-height:calc(100vh - 7.5rem);overflow:auto;padding:2rem 2.5rem;background:var(--s1);color:var(--text);box-shadow:0 0 0 1px var(--ink),5px 5px 0 rgba(0,0,0,.3)}
.lb-cmd{font-size:18px;line-height:1.65;color:var(--text)}.lb-term .stream{margin:1.5rem 0 0}.lb-term .stream pre{font-size:15px;max-height:none}.lb-term .quiet{margin-top:1.5rem;font-size:15px}
.lb-cap{grid-row:2;grid-column:2;display:flex;align-items:center;gap:1rem;margin:0;padding:.3rem .3rem .3rem 1rem;background:var(--chrome);border:var(--edge);font-size:12.5px;white-space:nowrap}
.lb-cap time,.lb-cap .size{font:12px var(--mono);color:var(--faint)}.lb-cap a{font-weight:700}.lb-cap .file{font:12px var(--mono);color:var(--text)}.lb-cap .label{font-size:12px}
.lb-nav{all:unset;box-sizing:border-box;grid-row:2;display:flex;align-items:center;gap:.75rem;min-width:0;max-width:22rem;padding:.3rem 1rem .3rem .3rem;background:var(--chrome);border:var(--edge);cursor:pointer}
.lb-nav.prev{grid-column:1;justify-self:start}.lb-nav.next{grid-column:3;justify-self:end;flex-direction:row-reverse;padding:.3rem .3rem .3rem 1rem;text-align:right}
.lb-nav .dir{flex:none;display:grid;place-items:center;width:1.9rem;height:1.9rem;background:var(--s1);border:var(--edge);font:400 1.3rem/1 var(--sans);color:var(--ink)}
.lb-nav:hover .dir{background:var(--tab)}.lb-nav:focus-visible{outline:2px solid var(--tab);outline-offset:3px}
.lb-nav .role{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 12px/1.4 var(--sans);color:var(--text)}
.enlarge{all:unset;margin-left:auto;display:flex;align-items:center;gap:.4rem;padding:.25rem 0;font-weight:700;color:var(--accent);cursor:zoom-in}.enlarge:hover{text-decoration:underline}.enlarge:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.close{all:unset;display:grid;place-items:center;width:1.9rem;height:1.9rem;background:var(--s1);border:var(--edge);color:var(--ink);font:400 1.2rem/1 var(--sans);cursor:pointer}.close:hover{background:var(--red);color:var(--on)}.close:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.void{display:grid;place-items:center;background:var(--chrome);border:var(--edge);color:var(--faint);padding:2rem;text-align:center;aspect-ratio:16/9}
.arrow{position:absolute;top:46%;translate:0 -50%;z-index:3;display:grid;place-items:center;width:2.5rem;height:2.5rem;background:var(--chrome);border:var(--edge);box-shadow:inset 1px 1px 0 var(--on),inset -1px -1px 0 var(--lo);color:var(--ink);font:400 1.5rem/1 var(--sans)}
.arrow.errs,.app:has(#focus-errors:checked) .arrow.all{display:none}.app:has(#focus-errors:checked) .arrow.errs{display:grid}
.arrow:hover{text-decoration:none;background:var(--tab)}.arrow.prev{left:1.25rem}.arrow.next{right:1.25rem}
.terminal .term{flex:0 1 auto;min-height:0}
.term{width:min(100%,56rem);max-height:100%;overflow:auto;background:var(--s1);box-shadow:0 0 0 1px var(--ink),4px 4px 0 rgba(0,0,0,.28)}
.term-bar{display:flex;align-items:center;gap:1rem;padding:.5rem 1.25rem;background:var(--tab);border-bottom:var(--edge);font-size:12px;font-weight:700;color:var(--text);position:sticky;top:0}
.dots{display:flex;gap:.3rem}.dots i{width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:0 0 0 1px var(--ink)}.dots i:first-child{background:var(--red)}.dots i:last-child{background:var(--desk)}
.term-cmd{padding:1rem 1.25rem;font-size:13px;color:var(--text)}.prompt{color:var(--faint);margin-right:.6em;user-select:none}
.term .stream{margin:0 1.25rem 1rem}.term .quiet,.term-note{margin:0 1.25rem 1rem;font-size:12.5px;color:var(--faint)}
.stream .label{display:block;margin-bottom:.25rem}.stream pre,.plain,.command{background:var(--s1);border:var(--rule);padding:.75rem .9rem;max-height:14rem;overflow:auto;color:var(--text)}
.panel{grid-area:panel;min-height:0;display:grid;grid-template-rows:minmax(0,1fr);background:var(--bg);border-left:var(--edge)}
.panel-scroll{overflow:auto;padding:1.5rem 1.5rem 3rem;scrollbar-width:thin;scrollbar-color:var(--s3) transparent}
.stephead{display:grid;grid-template-columns:1.75rem 1fr 1.75rem;align-items:center}.stepno{grid-column:2;margin:0;text-align:center;font:700 15px/1 var(--sans);color:var(--faint)}
.stepno .n{color:var(--text)}.stepno .d{font:700 44px/1 var(--sans);letter-spacing:-.04em}.stepno .n .d{color:var(--text);margin-left:.15rem}.stepno .of .d{font-size:15px;letter-spacing:0}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem 1rem;margin:1rem 0 0;padding-top:.5rem;border-top:var(--rule);font-size:12.5px;color:var(--dim)}.meta time{font-family:var(--mono)}
.permalink{grid-column:3;display:grid;place-items:center;width:1.75rem;height:1.75rem;color:var(--faint)}.permalink:hover{background:var(--s2);color:var(--text)}
.panel h2{font:700 1.35rem/1.3 var(--sans);letter-spacing:-.015em;margin:.5rem 0;overflow-wrap:anywhere}
.meta .state{margin-left:auto}
.block{margin-top:1.5rem}.block h3{margin:0 0 .5rem}.block p{margin:0;color:var(--dim)}.panel .block{margin-top:1.5rem;padding-top:.5rem;border-top:var(--rule)}.panel .block p{font-size:14px;line-height:1.57}
.command{font-size:12px;max-height:9rem}
.receipts{list-style:none;margin:0 0 .5rem;padding:0;display:grid;gap:.5rem}.receipts li{display:flex;flex-wrap:wrap;gap:.4rem .75rem;align-items:center}.diag{font-size:13px;color:var(--dim)}
.exit{display:inline-block;font:700 11.5px var(--mono);padding:.2rem .5rem;margin-bottom:.5rem}
.exit.ok{color:var(--on);background:var(--ok)}.exit.bad{color:var(--on);background:var(--bad)}
.receipts .exit{margin:0}.stream{margin-bottom:.5rem}
.raw summary{cursor:pointer;font-size:12px;font-weight:700;color:var(--faint);width:max-content}.raw summary:hover{color:var(--text)}.raw pre{margin-top:.5rem;color:var(--faint);font-size:11.5px;max-height:12rem;overflow:auto}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:1rem 1.5rem;margin:1.5rem 0 0;padding-top:.5rem;border-top:var(--rule)}.facts dd{margin:.15rem 0 0;font:12.5px var(--mono);color:var(--dim);overflow-wrap:anywhere}
.facts.stack{grid-template-columns:1fr}
.files{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}.files li{display:grid;justify-items:start}.files .fopen{font:12.5px var(--mono)}.files span{font-size:12px;color:var(--faint)}
.doc{display:block;overflow:auto;font-size:1rem;line-height:1.6;background:var(--desk)}
.doc-in{display:grid;grid-template-columns:12.5rem minmax(0,1fr);column-gap:2.5rem;width:min(100% - 4rem,62rem);margin:2.5rem auto 4rem;padding:0 2.5rem 3rem;background:var(--bg);border:var(--edge);box-shadow:5px 5px 0 rgba(0,0,0,.25)}
.doc-in>h2{grid-column:1/-1;justify-self:center;margin:0 0 0;padding:.5rem 1.5rem;background:var(--tab);border:var(--edge);border-top:0;font:700 1.125rem/1.2 var(--sans);letter-spacing:-.01em}
.doc-in>.lede{grid-column:1/-1;justify-self:center;max-width:40rem;text-align:center;color:var(--dim);margin:2rem 0 0;font-size:1.125rem;line-height:1.55}
.doc .block{grid-column:1/-1;display:grid;grid-template-columns:subgrid;margin-top:2.5rem;padding-top:.75rem;border-top:2px solid var(--ink)}.doc .block>*{grid-column:2}
.doc .block>h3{grid-column:1;display:block;margin:0;font:700 1.25rem/1.3 var(--sans);letter-spacing:-.015em;color:var(--text)}
.doc h3 .count{margin-left:.35rem;font:500 1rem var(--sans);color:var(--faint)}
.doc .vblock{padding:.75rem 0 1.25rem}.doc .vblock:first-of-type{border-top:0;padding-top:0}.doc .vblock h4{font-size:1.125rem;margin-bottom:.5rem}.doc .verdict{font-size:.875rem}
.doc .vwhy{font-size:.875rem;margin-bottom:.5rem}.doc .reasons{gap:1rem}.doc .reasons p{font-size:1rem;line-height:1.6}.doc .reasons .steps a{font-size:.8125rem}
.doc .quiet,.doc .vblock>.quiet{font-size:1rem}
.doc .findings li{padding:.75rem 0;font-size:1rem}.doc .findings li:first-child{padding-top:0;border-top:0}.doc .findings code{font-size:.8125rem}
.doc .group{padding:.75rem 0 1rem}.doc .group:first-child{padding-top:0;border-top:0}.doc .group summary{font-size:1.0625rem}.doc .group .count{font-size:.875rem}.doc .group[open] summary{margin-bottom:.75rem}
.doc .flist{font-size:.875rem;gap:.35rem}.doc .gallery{grid-template-columns:repeat(auto-fill,minmax(10rem,1fr));gap:1rem}.doc .gthumb{font-size:.8125rem}
.package{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.5rem 2.5rem}
.package .ids{display:grid;gap:1rem;margin:0}.package dt{font-size:.75rem}.package dd{margin:.15rem 0 0;font:.875rem var(--mono);color:var(--dim);overflow-wrap:anywhere}
.doc .files{gap:1rem}.doc .files .fopen{font-size:.875rem}.doc .files span{font-size:.8125rem}
@media(max-width:960px){.package{grid-template-columns:minmax(0,1fr)}.doc-in{grid-template-columns:minmax(0,1fr);width:calc(100% - 2rem);margin:1rem auto 3rem;padding:0 1.25rem 2rem}.doc .block>*,.doc .block>h3{grid-column:1}.doc .block>h3{margin-bottom:1rem}}
.findings{list-style:none;margin:0;padding:0;display:grid}.findings li{padding:.6rem 0;border-top:var(--rule)}
.findings summary{cursor:pointer}.findings code{display:block;font:11.5px/1.6 var(--mono);color:var(--faint);margin-top:.35rem;overflow-wrap:anywhere}
.outputs{display:grid}.group{padding:.6rem 0 .75rem;border-top:var(--rule)}
.group summary{display:flex;justify-content:space-between;gap:1rem;cursor:pointer;font-size:13px;list-style:none}.group summary::-webkit-details-marker{display:none}
.group summary{align-items:center}.group .where{display:inline-flex;align-items:center;gap:.6rem;font-weight:700}
.group .where::before{content:"";flex:none;width:.4rem;height:.4rem;border:solid var(--ink);border-width:0 2px 2px 0;rotate:-45deg;transition:rotate .15s}.group[open] .where::before{rotate:45deg}.group .count{color:var(--faint);flex:none}
.group[open] summary{margin-bottom:.75rem}
.flist{list-style:none;margin:-6px;padding:6px;display:grid;gap:.3rem;font:12px var(--mono);max-height:16rem;overflow:auto}.flist li{display:flex;justify-content:space-between;gap:1rem}.flist a{overflow-wrap:anywhere;min-width:0}.flist span{color:var(--faint);flex:none}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:1rem}.flist+.gallery{margin-top:1rem}
.gthumb{all:unset;box-sizing:border-box;cursor:zoom-in;display:grid;gap:.4rem;font:11.5px var(--mono);min-width:0;color:var(--dim)}.gthumb span{display:flex;justify-content:space-between;gap:.5rem;overflow:hidden;white-space:nowrap}.gthumb small{color:var(--faint);font-size:inherit;flex:none}
.gthumb img{width:100%;aspect-ratio:16/9;object-fit:contain;display:block;background:var(--desk);box-shadow:0 0 0 1px var(--dark);transition:box-shadow .15s}.gthumb:hover img,.gthumb:focus-visible img{box-shadow:0 0 0 3px var(--tab)}
.track{background:var(--chrome);border-top:1px solid var(--dark);box-shadow:inset 0 1px 0 var(--on)}
.track ol{min-width:0;list-style:none;margin:0;padding:.75rem 1.5rem 1rem;display:flex;justify-content:safe center;gap:1rem;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--lo) transparent}
.track li{flex:none;display:grid;gap:.4rem;padding:.25rem;transition:background .15s}
.track li:hover{background:var(--s2)}
.faces{display:flex;gap:.25rem}.faces a{display:block;width:8rem}.faces a:hover{text-decoration:none}
.face{display:block;aspect-ratio:16/9;overflow:hidden;background:var(--s1);box-shadow:0 0 0 1px var(--dark)}
.face img{width:100%;height:100%;object-fit:cover;display:block}
.face.text pre{padding:.5rem .55rem;font-size:9.5px;line-height:1.45;color:var(--dim);height:100%;overflow:hidden;-webkit-mask-image:linear-gradient(#000 60%,transparent);mask-image:linear-gradient(#000 60%,transparent)}
.cap{display:flex;align-items:center;gap:.4rem;width:0;min-width:100%;padding:0 .15rem;font-size:12px}.cap .took{flex:none;margin-left:auto;font:700 11px var(--sans);color:var(--text)}
.face .role{position:absolute;left:0;bottom:0;padding:.18rem .35rem;background:var(--tab);box-shadow:0 0 0 1px var(--ink);font:700 9.5px/1 var(--sans);color:var(--ink)}
.face .none{display:grid;place-items:center;height:100%;font-size:10px;color:var(--faint)}
.cap .n{font:700 11px var(--sans);color:var(--faint)}.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--tone)}
.cap .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim)}
.track li.bad .face{box-shadow:0 0 0 2px var(--red)}
@media(max-width:960px){.top{grid-template-columns:minmax(0,1fr)}.mid,.pills{justify-self:center;justify-content:center}.app{height:auto;min-height:100vh;overflow:visible}.center{grid-template-columns:minmax(0,1fr);grid-template-areas:"stage" "panel"}.panel{border-left:0;border-top:var(--edge)}
.stage{min-height:60vh}.view{padding:1rem 4rem 3rem}.track{position:sticky;bottom:0}}
.fopen{all:unset;cursor:pointer;color:var(--accent);overflow-wrap:anywhere;min-width:0}.fopen:hover{text-decoration:underline;text-underline-offset:3px}.fopen:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.fwin{position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:2rem;border:0;background:none;place-items:center;overflow:hidden;transition:overlay .28s allow-discrete,display .28s allow-discrete}
.fwin:popover-open{display:grid}
.fwin::backdrop{background:rgba(35,70,105,0);transition:background .28s ease,overlay .28s allow-discrete,display .28s allow-discrete}
.fwin:popover-open::backdrop{background:rgba(35,70,105,.55)}
@starting-style{.fwin:popover-open::backdrop{background:rgba(35,70,105,0)}}
.fw-card{width:min(52rem,100%);max-height:min(42rem,100%);display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--bg);border:var(--edge);box-shadow:5px 5px 0 rgba(0,0,0,.3);overflow:hidden;opacity:0;scale:.98;translate:0 .5rem;transition:opacity .22s ease,scale .28s cubic-bezier(.3,.9,.3,1),translate .28s cubic-bezier(.3,.9,.3,1)}
.fwin:popover-open .fw-card{opacity:1;scale:1;translate:0}
@starting-style{.fwin:popover-open .fw-card{opacity:0;scale:.98;translate:0 .5rem}}
.fw-bar{display:flex;align-items:center;gap:1rem;padding:.35rem .35rem .35rem 1rem;background:var(--tab);border-bottom:var(--edge)}
.fw-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:700 13px var(--mono);color:var(--ink)}
.fw-bar .size,.fw-note{flex:none;font:12px var(--mono);color:var(--ink)}
.fw-note{font:700 12px var(--sans);padding:.1rem .4rem;background:var(--s1);border:var(--edge)}
.fw-dl{flex:none;display:inline-flex;align-items:center;gap:.4rem;height:1.9rem;padding:0 .8rem 0 .65rem;background:var(--s1);border:var(--edge);color:var(--ink);font:700 12.5px var(--sans)}
.fw-dl:hover{text-decoration:none;background:var(--chrome)}
.fw-dl:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fw-body{margin:0;padding:1rem 1.25rem 1.25rem;overflow:auto;background:var(--s1);font:12.5px/1.6 var(--mono);color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media print{.app{height:auto;display:block}.track,.arrow,.mid,.lightbox,.enlarge{display:none}.center{display:block}.step{display:block!important;break-inside:avoid;margin-bottom:1rem}.view{display:flex!important}.stage{background:none}.sname{color:var(--text)}}`;
