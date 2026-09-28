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
const relayMark = `<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><rect x="3.5" y="4" width="12" height="9.5" rx="2.6" fill="none" stroke="#fff" stroke-width="2" opacity=".75"/><rect x="8.5" y="10" width="12" height="9.5" rx="2.6" fill="#f7862a" stroke="#fff" stroke-width="2.1"/><path d="M12 14.8h5M15.2 12.9l1.9 1.9-1.9 1.9" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
  + ",.app:not(:has(.center :target)) .track li:first-child{background:var(--s2)}"
  + [...Array.from({ length: views }, (_, k) => `.app:has([data-v="${k}"]:target) .track [data-t="${k}"] .face`),
    ...firsts.map(k => `.app:has(.center>.step[data-first="${k}"]:target) .track [data-t="${k}"] .face`),
    `.app:not(:has(.center :target)) .track [data-t="0"] .face`].join(",")
  + "{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--accent),0 0 18px var(--ring)}";

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

// Design (docs/ux-design.md §6.10): light, warm, minimal and vivid. A warm
// ivory canvas with white surfaces on soft warm shadows, one vermilion-to-
// marigold accent, round shapes, and separation by space and tone rather than
// borders. Status uses four vivid tones, each with its word.
export const reviewCss = `:root{color-scheme:light;--bg:#fbf6ef;--s1:#ffffff;--s2:#f7efe5;--s3:#efe3d5;--hair:rgba(90,50,20,.08);--text:#2a1d15;--dim:#5e4b3e;--faint:#7d6a5c;
--accent:#f0502a;--accent2:#ff9f1a;--grad:linear-gradient(135deg,var(--accent),var(--accent2));--on:#fff;--ring:rgba(240,80,42,.28);
--ok:#0e9f62;--bad:#e23744;--warn:#b87700;--warn-ink:#8a5a00;--shadow:0 1px 2px rgba(90,50,20,.06),0 12px 32px rgba(90,50,20,.10);
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--round:ui-rounded,"SF Pro Rounded",var(--sans);--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14.5px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:999px}
pre{font:12.5px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
b,time,.n,.exit,dd,.took{font-variant-numeric:tabular-nums}.d{font-family:var(--mono);font-weight:600;letter-spacing:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.label,h3,dt{font:600 11px/1.3 var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.quiet{color:var(--faint);margin:0}
.ok{--tone:var(--ok)}.bad{--tone:var(--bad)}.warn{--tone:var(--warn)}
.verdict{display:inline-flex;align-items:center;gap:.45rem;font:600 12.5px/1 var(--sans);color:var(--tone,var(--dim));text-transform:capitalize}
.verdict i{flex:none;width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 18%,transparent)}
.app{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;grid-template-columns:minmax(0,1fr);overflow:clip}.track{min-width:0;position:relative;z-index:0;display:grid}
.top{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:1rem .75rem;padding:1.1rem 1.25rem;position:relative;z-index:2}
.brand{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:.3rem .8rem;min-width:0}.brand .mark{grid-row:1/3}.brand h1,.brand .stats{grid-column:2;margin:0}
.mark{flex:none;display:grid;place-items:center;width:2.85rem;height:2.85rem;border-radius:14px;background:linear-gradient(145deg,#ffb23d,var(--accent) 70%);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),inset 0 -2px 6px rgba(160,40,10,.18),0 6px 18px var(--ring)}
h1{display:flex;align-items:baseline;gap:.6rem;font:700 1.3rem/1.15 var(--round);letter-spacing:-.015em;margin:0}
.stats .at time{font:600 12px var(--round);color:var(--text)}.stats .at .sep{margin:0 .35rem}
.stats{display:flex;flex-wrap:wrap;gap:.15rem .7rem;list-style:none;margin:.3rem 0 0;padding:0;font-size:12px;color:var(--faint)}.stats b{font:700 12px var(--round);color:var(--text)}
.pills{justify-self:end;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:.3rem;list-style:none;margin:0;padding:0}.pills>li,.stats>li{white-space:nowrap}
.pill{display:flex;align-items:center;gap:.4rem;padding:.42rem .7rem;border-radius:999px;background:color-mix(in srgb,var(--tone) 12%,transparent);font-size:12px;color:var(--dim)}
.mid{justify-self:center}
.tabs{display:flex;gap:.2rem;padding:.25rem;border-radius:999px;background:var(--s2)}
.tabs a{display:inline-flex;align-items:center;gap:.5rem;padding:.4rem 1rem;border-radius:999px;color:var(--dim);font-size:13px;font-weight:600}.tabs a:hover{text-decoration:none;color:var(--text)}
.tabs a span{display:grid;place-items:center;min-width:1.35rem;height:1.35rem;padding:0 .35rem;font:700 11px/1 var(--round);border-radius:999px;background:var(--s3);color:var(--dim)}.tabs a span.has{background:var(--grad);color:var(--on)}
.app:not(:has(#overview:target)) .t-traj,.app:has(#overview:target) .t-over{background:var(--s1);color:var(--text);box-shadow:var(--shadow)}
.pill button{all:unset;display:flex;align-items:center;gap:.4rem;cursor:pointer}.pill:has(button){padding-right:.4rem}.pill:has(button):hover{background:color-mix(in srgb,var(--tone) 20%,transparent)}
.pill button:focus-visible{outline:2px solid var(--accent);outline-offset:6px;border-radius:999px}
.q{display:grid;place-items:center;width:1.1rem;height:1.1rem;border-radius:50%;background:var(--tone);color:var(--on);font:700 10.5px/1 var(--round)}
.why{white-space:normal;text-align:left;position:fixed;inset:auto;top:4.6rem;right:1.75rem;margin:0;width:min(26rem,calc(100vw - 2rem));max-height:calc(100vh - 6rem);overflow:auto;padding:1.1rem 1.25rem 1.2rem;border:0;border-radius:18px;background:var(--s1);color:var(--text);box-shadow:0 2px 6px rgba(90,50,20,.08),0 24px 60px rgba(90,50,20,.22)}
.why h3{margin:0 0 .8rem;font:700 15px/1.3 var(--round);letter-spacing:0;text-transform:none;color:var(--text)}
.reasons{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}.reasons li{display:grid;gap:.4rem}.reasons p{margin:0;color:var(--dim);font-size:13.5px;line-height:1.5}
.reasons .steps{display:flex;flex-wrap:wrap;gap:.3rem}.reasons .steps a{padding:.15rem .55rem;border-radius:999px;background:var(--s2);font:600 11.5px var(--round)}.reasons .steps a:hover{background:var(--grad);color:var(--on);text-decoration:none}
.concern{margin-top:1.25rem;padding:1rem 1.1rem;border-radius:16px;background:color-mix(in srgb,var(--warn) 9%,var(--bg))}.concern h3{margin:0 0 .7rem;color:var(--warn-ink)}
.concern ul{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}.concern li{display:grid;gap:.2rem}.concern .label{color:var(--warn-ink)}.concern p{margin:0;color:var(--text);font-size:14px;line-height:1.55}
.vblock{padding:.95rem 1.1rem;border-radius:14px;background:var(--s1);box-shadow:var(--shadow)}.vblock+.vblock{margin-top:.6rem}
.vblock h4{display:flex;align-items:center;gap:.7rem;margin:0 0 .5rem;font:700 14px var(--round)}.vwhy{margin:0 0 .6rem;font-size:12.5px;color:var(--faint)}.vblock>.quiet{font-size:13.5px}
.face{position:relative}.flag{position:absolute;top:.35rem;right:.35rem;display:grid;place-items:center;width:1.1rem;height:1.1rem;border-radius:50%;background:var(--warn);color:#fff;font:800 11px/1 var(--round);box-shadow:0 2px 6px rgba(0,0,0,.2)}
.focus{position:absolute;left:1.5rem;bottom:1rem;z-index:4;display:flex;align-items:center;gap:.45rem;padding:.35rem .7rem .35rem .5rem;border-radius:999px;background:var(--bg);font-size:12px;font-weight:600;color:var(--dim);cursor:pointer;user-select:none}
.focus:hover{background:var(--s2)}.focus input{appearance:none;margin:0;width:1.05rem;height:1.05rem;border-radius:6px;background:var(--s1);box-shadow:inset 0 0 0 1.5px var(--faint);display:grid;place-items:center;cursor:pointer}
.focus input:checked{background:var(--bad);box-shadow:none}.focus input:checked::after{content:"";width:.28rem;height:.55rem;border:solid #fff;border-width:0 2px 2px 0;rotate:45deg;translate:0 -1px}

.app:has(#focus-errors:checked) .track li:not(.err){opacity:.35;filter:grayscale(1)}
.app:has(#focus-errors:checked) .track li.err .face{box-shadow:0 0 0 2px var(--bad),0 6px 16px color-mix(in srgb,var(--bad) 25%,transparent)}
.app:has(#focus-errors:checked) .track li.err .t{color:var(--bad)}
.app:has(#overview:target) .track{display:none}.app:has(#overview:target) .focus{display:none}.app:has(#overview:target) .keys{display:none}
.keys{display:flex;align-items:center;gap:.25rem;margin-right:.4rem;font-size:11px;color:var(--faint)}.keys span{margin:0 .35rem 0 .1rem}.keys span:last-child{margin-right:0}
kbd{display:inline-grid;place-items:center;min-width:1.3rem;height:1.3rem;padding:0 .3rem;border-radius:6px;background:var(--s1);box-shadow:0 0 0 1px var(--hair),0 1.5px 0 var(--s3);font:600 10.5px/1 var(--sans);color:var(--dim)}.overview>.doc{grid-area:auto;grid-column:1/-1;grid-row:1}
.center{display:grid;grid-template-columns:minmax(0,1fr) minmax(20rem,25rem);grid-template-areas:"stage panel";gap:0 .75rem;padding:0 .75rem;min-height:0;position:relative;z-index:1}
.step{display:none}.step:is(:target,:has(:target)){display:contents}.center:not(:has(:target))>.step:first-of-type{display:contents}
.step>.view{display:none}.step>.view:target,.step:target>.view.first,.center:not(:has(:target))>.step:first-of-type>.view.first{display:flex}
.stage{grid-area:stage;position:relative;min-width:0;min-height:0;background:var(--bg);display:grid;grid-template-rows:minmax(0,1fr);overflow:clip}
.view{flex-direction:column;align-items:center;justify-content:center;gap:1rem;padding:1.5rem 4.75rem 1.25rem}
.solo{flex:0 1 auto;min-height:0;max-width:100%;display:flex;justify-content:center}
.zoom{all:unset;display:flex;min-height:0;max-height:100%;max-width:100%;cursor:zoom-in;border-radius:12px}.zoom:focus-visible{outline:none}
.solo img{max-width:100%;max-height:100%;object-fit:contain;border-radius:12px;box-shadow:0 2px 4px rgba(60,30,10,.08),0 18px 44px rgba(60,30,10,.16);background:#fff;transition:box-shadow .15s}
.zoom:hover img,.zoom:focus-visible img{box-shadow:0 0 0 2px var(--accent),0 18px 44px rgba(60,30,10,.18)}
.vlabel{display:grid;justify-items:center;gap:.55rem;min-width:0}
.badge{display:inline-flex;align-items:center;gap:.65rem;padding:.32rem .85rem;border-radius:999px;background:var(--s1);box-shadow:0 0 0 1px var(--hair),0 1px 3px rgba(90,50,20,.07)}
.badge .role{font:600 11px/1 var(--sans);letter-spacing:.07em;text-transform:uppercase;color:var(--dim)}.badge[data-role="after"] .role{color:var(--accent)}.badge time{font:12px/1 var(--mono);color:var(--faint)}
.sname{flex:none;display:flex;align-items:baseline;gap:.6rem;max-width:100%;margin:0;font:700 17px/1.35 var(--round);letter-spacing:-.005em;color:var(--text)}
.sname .d{flex:none;font-size:13px;color:var(--faint)}.sname .h{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sname .took{flex:none;align-self:center;padding:.18rem .5rem;border-radius:999px;background:color-mix(in srgb,var(--accent) 11%,transparent);font:700 11.5px/1 var(--round);color:var(--accent)}
.lightbox{position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:1.5rem 1.5rem 1.25rem;border:0;background:none;color:var(--text);overflow:hidden;transition:overlay .36s allow-discrete,display .36s allow-discrete}
.lb-body>*{transform-origin:0 0;transition:transform .36s cubic-bezier(.3,.9,.3,1),opacity .24s ease}
.lightbox:not([data-flip]):not(:popover-open) .lb-body>*{opacity:0}@starting-style{.lightbox:popover-open:not([data-flip]) .lb-body>*{opacity:0}}
.lightbox>:not(.lb-body){translate:0 calc(100% + 2.5rem);transition:translate .36s cubic-bezier(.3,.9,.3,1)}.lightbox:popover-open>:not(.lb-body){translate:0}@starting-style{.lightbox:popover-open>:not(.lb-body){translate:0 calc(100% + 2.5rem)}}
.lightbox{grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;gap:1rem 1.25rem;align-items:center}.lightbox:popover-open{display:grid}
.lightbox::backdrop{background:rgba(22,15,10,0);backdrop-filter:blur(0);transition:background .32s ease,backdrop-filter .32s ease,overlay .36s allow-discrete,display .36s allow-discrete}
.lightbox:popover-open::backdrop{background:rgba(22,15,10,.9);backdrop-filter:blur(10px)}@starting-style{.lightbox:popover-open::backdrop{background:rgba(22,15,10,0);backdrop-filter:blur(0)}}
.lightbox[data-instant],.lightbox[data-instant]::backdrop,.lightbox[data-instant]>*,.lightbox[data-instant] .lb-body>*{transition:none}
.lb-body{grid-column:1/-1;grid-row:1;display:grid;place-items:center;min-height:0;height:100%;pointer-events:none}.lb-body>*{pointer-events:auto}
.lb-body img{display:block;max-width:100%;max-height:calc(100vh - 7.5rem);object-fit:contain;border-radius:14px;background:#fff;box-shadow:0 30px 90px rgba(0,0,0,.5)}
.lb-term{width:min(100%,72rem);max-height:calc(100vh - 7.5rem);overflow:auto;padding:2rem 2.25rem;border-radius:22px;background:var(--s1);color:var(--text);box-shadow:0 30px 90px rgba(0,0,0,.5)}
.lb-cmd{font-size:18px;line-height:1.65;color:var(--text)}.lb-term .stream{margin:1.25rem 0 0}.lb-term .stream pre{font-size:15px;max-height:none}.lb-term .quiet{margin-top:1.25rem;font-size:15px}
.lb-cap{grid-row:2;grid-column:2;display:flex;align-items:center;gap:.9rem;margin:0;padding:.35rem .45rem .35rem 1rem;border-radius:999px;background:var(--s1);box-shadow:0 8px 28px rgba(0,0,0,.35);font-size:12.5px;white-space:nowrap}
.lb-cap time,.lb-cap .size{font:12px var(--mono);color:var(--faint)}.lb-cap a{font-weight:600}.lb-cap .file{font:12px var(--mono);color:var(--text)}
.lb-nav{all:unset;box-sizing:border-box;grid-row:2;display:flex;align-items:center;gap:.7rem;min-width:0;max-width:22rem;padding:.35rem 1rem .35rem .35rem;border-radius:999px;background:var(--s1);box-shadow:0 8px 28px rgba(0,0,0,.35);cursor:pointer}
.lb-nav.prev{grid-column:1;justify-self:start}.lb-nav.next{grid-column:3;justify-self:end;flex-direction:row-reverse;padding:.35rem .35rem .35rem 1rem;text-align:right}
.lb-nav .dir{flex:none;display:grid;place-items:center;width:2.1rem;height:2.1rem;border-radius:50%;background:var(--s2);font-size:1.3rem;line-height:1;color:var(--text)}
.lb-nav:hover .dir{background:var(--grad);color:var(--on)}.lb-nav:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.lb-nav .role{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 10.5px/1.4 var(--sans);letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}
.enlarge{all:unset;margin-left:auto;display:flex;align-items:center;gap:.4rem;padding:.3rem .7rem;border-radius:999px;font-weight:600;color:var(--dim);cursor:zoom-in}.enlarge:hover{background:var(--s2);color:var(--accent)}.enlarge:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.close{all:unset;display:grid;place-items:center;width:1.8rem;height:1.8rem;border-radius:50%;background:var(--s2);color:var(--dim);font:600 1.1rem/1 var(--sans);cursor:pointer}.close:hover{background:var(--grad);color:var(--on)}.close:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.void{display:grid;place-items:center;border-radius:14px;background:var(--s1);color:var(--faint);padding:2rem;text-align:center;aspect-ratio:16/9}
.arrow{position:absolute;top:50%;translate:0 -50%;z-index:3;display:grid;place-items:center;width:2.75rem;height:2.75rem;border-radius:50%;background:rgba(255,255,255,.85);backdrop-filter:blur(8px);color:var(--text);font-size:1.5rem;line-height:1;box-shadow:var(--shadow)}
.arrow.errs,.app:has(#focus-errors:checked) .arrow.all{display:none}.app:has(#focus-errors:checked) .arrow.errs{display:grid}
.arrow:hover{text-decoration:none;background:var(--grad);color:var(--on)}.arrow.prev{left:1rem}.arrow.next{right:1rem}
.terminal .term{flex:0 1 auto;min-height:0}
.term{width:min(100%,56rem);max-height:100%;overflow:auto;background:var(--s1);border-radius:18px;box-shadow:var(--shadow)}
.term-bar{display:flex;align-items:center;gap:1rem;padding:.8rem 1.1rem;font-size:12px;color:var(--faint);position:sticky;top:0;background:var(--s1)}
.dots{display:flex;gap:.35rem}.dots i{width:10px;height:10px;border-radius:50%;background:var(--s3)}.dots i:first-child{background:var(--grad)}
.term-cmd{padding:.4rem 1.2rem 1.1rem;font-size:13px;color:var(--text)}.prompt{color:var(--accent);margin-right:.6em;user-select:none}
.term .stream{margin:0 1.2rem 1rem}.term .quiet,.term-note{margin:0 1.2rem 1.1rem;font-size:12.5px;color:var(--faint)}
.stream .label{display:block;margin-bottom:.35rem}.stream pre,.plain,.command{background:var(--s2);border-radius:12px;padding:.75rem .9rem;max-height:14rem;overflow:auto;color:var(--text)}
.panel{grid-area:panel;min-height:0;display:grid;grid-template-rows:minmax(0,1fr)}
.panel-scroll{overflow:auto;padding:1.25rem .5rem 2.5rem 1rem;scrollbar-width:thin;scrollbar-color:var(--s3) transparent;--fade:linear-gradient(transparent,#000 1.25rem,#000 calc(100% - 2.5rem),transparent);-webkit-mask-image:var(--fade);mask-image:var(--fade)}
.panel .stream pre,.panel .plain,.panel .command{background:var(--s1);box-shadow:0 0 0 1px var(--hair),0 1px 2px rgba(90,50,20,.05);padding:.8rem .95rem}
.stephead{display:flex;align-items:center;gap:.75rem}.stepno{margin:0;font:700 1.45rem/1.2 var(--round);letter-spacing:-.015em;color:var(--faint)}
.stepno .n{color:var(--text)}.stepno .of{font-size:1rem;font-weight:600}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .9rem;margin:.45rem 0 0;font-size:12.5px;color:var(--faint)}.meta time{font-family:var(--mono)}
.permalink{margin-left:auto;display:grid;place-items:center;width:1.9rem;height:1.9rem;margin-block:-.4rem;border-radius:999px;color:var(--faint)}.permalink:hover{background:var(--s3);color:var(--text)}
.panel h2{font:700 1.35rem/1.3 var(--round);letter-spacing:-.012em;margin:.55rem 0 .6rem;overflow-wrap:anywhere}
.meta .state{margin-left:auto}
.block{margin-top:1.5rem}.block h3{margin:0 0 .45rem}.block p{margin:0;color:var(--dim)}.panel .block{margin-top:1.75rem}.panel .block h3{margin-bottom:.55rem}.panel .block p{font-size:14px;line-height:1.6}
.command{font-size:12px;max-height:9rem}
.receipts{list-style:none;margin:0 0 .4rem;padding:0;display:grid;gap:.45rem}.receipts li{display:flex;flex-wrap:wrap;gap:.4rem .8rem;align-items:center}.diag{font-size:13px;color:var(--dim)}
.exit{display:inline-block;font:700 11.5px var(--mono);padding:.25rem .6rem;border-radius:999px;margin-bottom:.55rem}
.exit.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 15%,transparent)}.exit.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 15%,transparent)}
.receipts .exit{margin:0}.stream{margin-bottom:.6rem}
.raw summary{cursor:pointer;font-size:12px;color:var(--faint);width:max-content}.raw summary:hover{color:var(--dim)}.raw pre{margin-top:.5rem;color:var(--faint);font-size:11.5px;max-height:12rem;overflow:auto}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:1rem 1.25rem;margin:1.75rem 0 0;padding:0}.facts dd{margin:.2rem 0 0;font:12.5px var(--mono);color:var(--dim);overflow-wrap:anywhere}
.facts.stack{grid-template-columns:1fr}
.files{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}.files li{display:grid;justify-items:start}.files .fopen{font:12.5px var(--mono)}.files span{font-size:12px;color:var(--faint)}
.doc{display:block;overflow:auto;font-size:1rem;line-height:1.6}.doc-in{width:100%;max-width:56rem;margin:0 auto;padding:2.75rem 2.75rem 4rem}
.doc h2{font:700 2.25rem/1.15 var(--round);letter-spacing:-.02em;margin:0}.lede{color:var(--dim);margin:.85rem 0 0;font-size:1.125rem;line-height:1.6}
.doc .block{margin-top:2.75rem}.doc .block>h3{display:flex;align-items:baseline;gap:.6rem;margin:0 0 1rem;font:700 1.25rem/1.3 var(--round);letter-spacing:-.005em;text-transform:none;color:var(--text)}
.doc h3 .count{font:600 .875rem var(--round);color:var(--faint)}
.doc .vblock{padding:1.2rem 1.4rem;border-radius:18px}.doc .vblock+.vblock{margin-top:.75rem}.doc .vblock h4{font-size:1.0625rem;margin-bottom:.6rem}.doc .verdict{font-size:.875rem}
.doc .vwhy{font-size:.875rem;margin-bottom:.7rem}.doc .reasons{gap:1rem}.doc .reasons p{font-size:1rem;line-height:1.6}.doc .reasons .steps a{font-size:.8125rem;padding:.2rem .65rem}
.doc .quiet,.doc .vblock>.quiet{font-size:1rem}
.doc .findings{gap:.6rem}.doc .findings li{padding:1rem 1.25rem;border-radius:18px;font-size:1rem}.doc .findings code{font-size:.8125rem}
.doc .group{padding:1rem 1.25rem;border-radius:18px}.doc .group summary{font-size:1.0625rem}.doc .group .count{font-size:.875rem}.doc .group[open] summary{margin-bottom:1rem}
.doc .flist{font-size:.875rem;gap:.4rem}.doc .gallery{grid-template-columns:repeat(auto-fill,minmax(11rem,1fr));gap:1rem}.doc .gthumb{font-size:.8125rem}
.package{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.5rem;padding:1.25rem 1.4rem;border-radius:18px;background:var(--s1);box-shadow:var(--shadow)}
.package .ids{display:grid;gap:.9rem;margin:0}.package dt{font-size:.75rem}.package dd{margin:.2rem 0 0;font:.875rem var(--mono);color:var(--dim);overflow-wrap:anywhere}
.doc .files{gap:.9rem}.doc .files .fopen{font-size:.875rem}.doc .files span{font-size:.8125rem}
@media(max-width:960px){.package{grid-template-columns:minmax(0,1fr)}}
.findings{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}.findings li{padding:.8rem 1rem;border-radius:14px;background:var(--s1);box-shadow:var(--shadow)}
.findings summary{cursor:pointer}.findings code{display:block;font:11.5px/1.6 var(--mono);color:var(--faint);margin-top:.4rem;overflow-wrap:anywhere}
.outputs{display:grid;gap:.5rem}.group{background:var(--s1);border-radius:14px;padding:.75rem 1rem;box-shadow:var(--shadow)}
.group summary{display:flex;justify-content:space-between;gap:1rem;cursor:pointer;font-size:13px;list-style:none}.group summary::-webkit-details-marker{display:none}
.group summary{align-items:center}.group .where{display:inline-flex;align-items:center;gap:.7rem;font-weight:600}
.group .where::before{content:"";flex:none;width:.4rem;height:.4rem;border:solid var(--accent);border-width:0 1.5px 1.5px 0;rotate:-45deg;transition:rotate .15s}.group[open] .where::before{rotate:45deg}.group .count{color:var(--faint);flex:none}
.group[open] summary{margin-bottom:.75rem}
.flist{list-style:none;margin:-6px;padding:6px;display:grid;gap:.3rem;font:12px var(--mono);max-height:16rem;overflow:auto}.flist li{display:flex;justify-content:space-between;gap:1rem}.flist a{overflow-wrap:anywhere;min-width:0}.flist span{color:var(--faint);flex:none}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:.75rem}.flist+.gallery{margin-top:.75rem}
.gthumb{all:unset;box-sizing:border-box;cursor:zoom-in;display:grid;gap:.4rem;font:11.5px var(--mono);min-width:0;color:var(--dim)}.gthumb span{display:flex;justify-content:space-between;gap:.5rem;overflow:hidden;white-space:nowrap}.gthumb small{color:var(--faint);font-size:inherit;flex:none}
.gthumb img{width:100%;aspect-ratio:16/9;object-fit:contain;border-radius:10px;display:block;background:var(--s2);box-shadow:inset 0 0 0 1px var(--hair);transition:box-shadow .15s}.gthumb:hover img,.gthumb:focus-visible img{box-shadow:0 0 0 2px var(--accent)}
.track ol{min-width:0;list-style:none;margin:0;padding:.75rem 1.75rem 1rem;display:flex;gap:.6rem;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--s3) transparent}
.track li{flex:none;display:grid;gap:.45rem;padding:.35rem;border-radius:16px;transition:background .15s}
.track li:hover{background:var(--s1)}
.faces{display:flex;gap:.3rem}.faces a{display:block;width:8rem}.faces a:hover{text-decoration:none}
.face{display:block;aspect-ratio:16/9;border-radius:11px;overflow:hidden;background:var(--s1);box-shadow:0 1px 2px rgba(90,50,20,.08),0 6px 16px rgba(90,50,20,.08)}
.face img{width:100%;height:100%;object-fit:cover;display:block}
.face.text pre{padding:.55rem .6rem;font-size:9.5px;line-height:1.45;color:var(--dim);height:100%;overflow:hidden;-webkit-mask-image:linear-gradient(#000 60%,transparent);mask-image:linear-gradient(#000 60%,transparent)}
.cap{display:flex;align-items:center;gap:.4rem;width:0;min-width:100%;padding:0 .2rem;font-size:12px}.cap .took{flex:none;margin-left:auto;font:700 10.5px var(--round);color:var(--accent)}
.face .role{position:absolute;left:.3rem;bottom:.3rem;padding:.14rem .4rem;border-radius:999px;background:rgba(255,255,255,.9);font:600 9px/1 var(--sans);letter-spacing:.07em;text-transform:uppercase;color:var(--dim)}
.face .none{display:grid;place-items:center;height:100%;font-size:10px;color:var(--faint)}
.cap .n{font:600 11px var(--mono);color:var(--faint)}.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--tone)}
.cap .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim)}
.track li.bad .face{box-shadow:0 0 0 2px var(--bad)}
@media(max-width:960px){.top{grid-template-columns:minmax(0,1fr)}.pills{justify-self:center;justify-content:center}.app{height:auto;min-height:100vh;overflow:visible}.center{grid-template-columns:minmax(0,1fr);grid-template-areas:"stage" "panel";gap:.75rem}
.stage{min-height:60vh}.view{padding:.5rem 3.75rem 1rem}.track{position:sticky;bottom:0;background:var(--bg)}}
@supports (corner-shape:squircle){*,*::before,*::after,::backdrop{corner-shape:squircle}.dot,.verdict i,.arrow,.q,.flag,.close,.dots i,.lb-nav .dir,
:focus-visible,.pill,.tabs,.tabs a,.tabs a span,.reasons .steps a,.took,.badge,.face .role,.focus,.lb-cap,.lb-nav,.enlarge,.permalink,.exit,.fw-dl,.fopen{corner-shape:round}}
.fopen{all:unset;cursor:pointer;color:var(--accent);overflow-wrap:anywhere;min-width:0}.fopen:hover{text-decoration:underline;text-underline-offset:3px}.fopen:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:999px}
.fwin{position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;margin:0;padding:2rem;border:0;background:none;place-items:center;overflow:hidden;transition:overlay .28s allow-discrete,display .28s allow-discrete}
.fwin:popover-open{display:grid}
.fwin::backdrop{background:rgba(42,29,21,0);transition:background .28s ease,overlay .28s allow-discrete,display .28s allow-discrete}
.fwin:popover-open::backdrop{background:rgba(42,29,21,.3)}
@starting-style{.fwin:popover-open::backdrop{background:rgba(42,29,21,0)}}
.fw-card{width:min(52rem,100%);max-height:min(42rem,100%);display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--s1);border-radius:18px;box-shadow:0 1px 2px rgba(90,50,20,.08),0 24px 64px rgba(60,30,10,.24);overflow:hidden;opacity:0;scale:.96;translate:0 .75rem;transition:opacity .22s ease,scale .28s cubic-bezier(.3,.9,.3,1),translate .28s cubic-bezier(.3,.9,.3,1)}
.fwin:popover-open .fw-card{opacity:1;scale:1;translate:0}
@starting-style{.fwin:popover-open .fw-card{opacity:0;scale:.96;translate:0 .75rem}}
.fw-bar{display:flex;align-items:center;gap:.75rem;padding:.7rem .7rem .7rem 1.15rem;border-bottom:1px solid var(--hair)}
.fw-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 13px var(--mono);color:var(--text)}
.fw-bar .size,.fw-note{flex:none;font:12px var(--mono);color:var(--faint)}
.fw-note{font-family:var(--sans)}
.fw-dl{flex:none;display:inline-flex;align-items:center;gap:.4rem;padding:.4rem .85rem .4rem .7rem;border-radius:999px;background:var(--grad);color:var(--on);font-size:12.5px;font-weight:600}
.fw-dl:hover{text-decoration:none;filter:brightness(1.05)}
.fw-dl:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.fw-body{margin:0;padding:1rem 1.15rem 1.25rem;overflow:auto;background:var(--bg);font:12.5px/1.6 var(--mono);color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media print{.app{height:auto;display:block}.track,.arrow,.mid,.lightbox,.enlarge{display:none}.center{display:block}.step{display:block!important;break-inside:avoid;margin-bottom:1rem}.view{display:flex!important}.stage{background:none}}`;
