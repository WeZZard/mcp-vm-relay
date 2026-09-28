// The offline review page (index.html) of a delivered evidence package.
//
// The page is a pure function of the package's retained evidence: delivery
// writes it once, and verification renders it again and requires the same
// bytes. It therefore reads no clock, no environment and no file beyond the
// model it is given. It opens from file:// under a policy that admits one
// script, the arrow-key navigation below, by its hash, and forbids every
// network request. Everything else is a plain link, an anchor or <details>.
// The visual design is specified in docs/ux-design.md §6.10.

import { createHash } from "node:crypto";

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
}

export const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const src = (path: string) => escapeHtml(path.split("/").map(encodeURIComponent).join("/"));
const link = (step: ReviewPageStep) => `#step-${encodeURIComponent(step.id)}`;
const time = (iso?: string) => iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(11, 19) : undefined;
const preciseTime = (iso?: string) => iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString().slice(11, 23) : undefined;
const duration = (ms: number) => ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 27, 2026, 20:08 UTC". Formatted by hand so the page's bytes do not depend on the ICU build. */
const utcStamp = (iso: string) => {
  const d = new Date(iso), two = (n: number) => String(n).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
};
/** The relay's mark: a trajectory from a start, through a waypoint, to its target. */
const relayMark = `<svg viewBox="0 0 24 24" width="25" height="25" aria-hidden="true"><path d="M5 18.5c4.8 0 4.4-6.5 7-6.5s2.2-6.5 7-6.5" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/><circle cx="5" cy="18.5" r="2.6" fill="#fff"/><circle cx="12" cy="12" r="2.1" fill="#f36a2b" stroke="#fff" stroke-width="1.9"/><circle cx="19" cy="5.5" r="3.3" fill="#f7862a" stroke="#fff" stroke-width="2.1"/><circle cx="19" cy="5.5" r="1.1" fill="#fff"/></svg>`;
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

/** One snapshot, fitted to the viewport. Pressing it opens the snapshot in the lightbox. */
function shot(step: ReviewPageStep, detail: StepDetail | undefined, role: "before" | "after") {
  const path = step.snapshots?.[role];
  const name = role === "before" ? "Before" : "After";
  const at = preciseTime(role === "before" ? detail?.beforeAt : detail?.afterAt);
  const caption = `<figcaption><span class="label">${name}</span>${at ? `<time>${at}</time>` : ""}</figcaption>`;
  if (!path) return `<figure class="shot missing"><div class="void">${name}: unavailable — incomplete evidence</div>${caption}</figure>`;
  return `<figure class="shot"><button type="button" class="zoom" popovertarget="${escapeHtml(boxId(step, role))}" title="Enlarge the ${role} snapshot"><img alt="${name} dispatch snapshot" src="${src(path)}"></button>${caption}</figure>`;
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
    const detail = model.details.get(step.id), number = numbers.get(step.id)!, { headline, command } = describe(step, detail), view = `step-${step.id}`;
    if (!step.snapshots) {
      const at = time(detail?.at);
      return [{ id: boxId(step, "command"), step: view, label: `Step ${number} · ${step.inputMode === "diagnostic" ? "Diagnostic" : "Command"}`, title: headline,
        body: `<div class="lb-term"><pre class="lb-cmd"><span class="prompt" aria-hidden="true">$</span>${escapeHtml(command ?? headline)}</pre>${detail?.output ? streamsOf(detail.output) || `<p class="quiet">No output.</p>` : ""}</div>`,
        caption: at ? `<time>${at} UTC</time>` : "" }];
    }
    return (["before", "after"] as const).filter(role => step.snapshots?.[role]).map(role => {
      const path = step.snapshots![role]!, name = role === "before" ? "Before" : "After", at = preciseTime(role === "before" ? detail?.beforeAt : detail?.afterAt);
      return { id: boxId(step, role), step: view, label: `Step ${number} · ${name}`, title: headline,
        body: `<img loading="lazy" alt="${name} dispatch snapshot, enlarged" src="${src(path)}">`,
        caption: `${at ? `<time>${at}</time>` : ""}<a href="${src(path)}">Open the original</a>` };
    });
  });
}

/** The steps around a step: adjacent ones, and the nearest ones with errors. */
type Around = { previous?: ReviewPageStep; next?: ReviewPageStep; previousError?: ReviewPageStep; nextError?: ReviewPageStep };

/** The viewport of a step: its before and after snapshots side by side, or its command. */
function stage(step: ReviewPageStep, detail: StepDetail | undefined, number: string, around: Around) {
  const { headline, command } = describe(step, detail);
  // Two pairs of arrows: to the adjacent steps, and to the nearest steps with
  // errors. "Focus on errors" shows the second pair instead of the first.
  const arrow = (target: ReviewPageStep | undefined, side: "prev" | "next", set: "all" | "errs") => target
    ? `<a class="arrow ${side} ${set}" href="${escapeHtml(link(target))}" aria-label="${side === "prev" ? "Previous" : "Next"} step${set === "errs" ? " with errors" : ""}">${side === "prev" ? "‹" : "›"}</a>` : "";
  const arrows = arrow(around.previous, "prev", "all") + arrow(around.next, "next", "all") + arrow(around.previousError, "prev", "errs") + arrow(around.nextError, "next", "errs");
  if (!step.snapshots) {
    return `<section class="stage terminal" aria-label="Step ${number} command">${arrows}<div class="term"><div class="term-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${step.inputMode === "diagnostic" ? "Diagnostic command" : "Command"} · no snapshots</span><button type="button" class="enlarge" popovertarget="${escapeHtml(boxId(step, "command"))}" title="Enlarge the command">${expandIcon}Enlarge</button></div>
<pre class="term-cmd"><span class="prompt" aria-hidden="true">$</span>${escapeHtml(command ?? headline)}</pre>${detail?.output ? streamsOf(detail.output) || `<p class="quiet">No output.</p>` : ""}
<p class="term-note">${step.inputMode === "diagnostic" ? "Screenshots were not requested for this diagnostic." : "No snapshots were captured for this step."}</p></div></section>`;
  }
  return `<section class="stage" aria-label="Step ${number} snapshots">${arrows}<div class="pair">${shot(step, detail, "before")}${shot(step, detail, "after")}</div></section>`;
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
<p class="eyebrow"><span>Step <span class="d">${number}</span> <span class="of">of <span class="d">${String(total).padStart(2, "0")}</span></span></span><span>${kind}</span>${at ? `<time>${at} UTC</time>` : ""}<a class="permalink" href="${escapeHtml(link(step))}" title="Stable link to this step" aria-label="Stable link to step ${number}">${linkIcon}</a></p>
<h2>${escapeHtml(headline)}</h2><p class="state"><span class="sr">Execution: </span>${verdict(step.execution)}</p>
${concerns.length ? `<section class="concern"><h3>Why this step affects the verdicts</h3><ul>${concerns.map(c => `<li><span class="label">${escapeHtml(c.verdict)}</span><p>${escapeHtml(c.text)}</p></li>`).join("")}</ul></section>` : ""}
${reasonShown ? `<section class="block"><h3>Reason</h3><p>${escapeHtml(step.because ?? "Not present in retained host metadata")}</p></section>` : ""}
${command && step.snapshots ? `<section class="block"><h3>Command</h3><pre class="command">${escapeHtml(command)}</pre></section>` : ""}
<section class="block"><h3>Expected</h3><p>${escapeHtml(step.expected || "Not supplied")}</p></section>
<section class="block"><h3>Observed</h3>${observed(step, detail?.output, !!step.snapshots)}</section>
<dl class="facts">${fact("State", escapeHtml(step.state))}${fact("Input", escapeHtml(step.inputMode))}${fact("After interval", interval === undefined ? "unavailable" : `${interval} ms`)}${took(detail) ? fact("Before to after", took(detail)!) : ""}${step.snapshots?.groupId ? fact("Group", escapeHtml(step.snapshots.groupId)) : ""}</dl>
</div></aside>`;
}

const linkIcon = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M6.6 9.4l2.8-2.8M7.2 4.6l.9-.9a2.8 2.8 0 0 1 4 4l-.9.9M8.8 11.4l-.9.9a2.8 2.8 0 0 1-4-4l.9-.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

/** One thumbnail of the bottom track: the step's after snapshot, or its command. */
function thumb(step: ReviewPageStep, detail: StepDetail | undefined, number: string, flagged: boolean) {
  const { headline, command } = describe(step, detail);
  const image = step.snapshots?.after ?? step.snapshots?.before;
  const face = image ? `<img loading="lazy" alt="" src="${src(image)}">` : `<pre aria-hidden="true"><span class="prompt">$</span>${escapeHtml(command ?? headline)}</pre>`;
  const span = took(detail);
  return `<li class="${tone(step.execution)}${step.inputMode === "diagnostic" ? " diagnostic" : ""}${erred(step) ? " err" : ""}"><a href="${escapeHtml(link(step))}" title="${escapeHtml(headline)}"><span class="face${image ? "" : " text"}">${face}${span ? `<span class="took" title="Time from the before snapshot to the after snapshot">${span}</span>` : ""}${flagged ? `<span class="flag" title="This step affects the verdicts">!</span>` : ""}</span><span class="cap"><span class="n">${number}</span><i class="dot" aria-hidden="true"></i><span class="t">${escapeHtml(headline)}</span></span><span class="sr">${escapeHtml(step.execution)}</span></a></li>`;
}

// Without script, the selected step is the :target. Each rule below ties a
// step's position to its thumbnail; with no target, the first step shows.
// The left and right arrow keys move to the previous and next step, or to
// the previous and next step with errors while "Focus on errors" is checked.
// The track keeps the selected thumbnail in view, and the Trajectory tab
// returns to the step last shown. Space opens the selected step's lightbox,
// at its before snapshot, and closes it again. While a lightbox is open, the
// arrow keys and its arrows move through its sequence, and the page follows
// to the item's step. The run's time is shown in the reader's own time zone. Links
// alone cannot bind keys or read the reader's time zone.
const keys = `(()=>{const steps=()=>[...document.querySelectorAll(".center>.step:not(.overview)")];`
  + `const still=()=>matchMedia("(prefers-reduced-motion: reduce)").matches,body=box=>box.querySelector(".lb-body>*");`
  + `const sourceOf=box=>{for(const o of document.querySelectorAll(".zoom,.enlarge,.gthumb")){if(o.getAttribute("popovertarget")!==box.id)continue;`
  + `const s=o.classList.contains("enlarge")?o.closest(".term"):o.querySelector("img");if(s&&s.getBoundingClientRect().width)return s}return null};`
  // The transform that lays an element over the source's rectangle, measured
  // from the element's own untransformed place; the element keeps its current
  // (possibly mid-flight) look until the caller animates it.
  + `const from=(el,src)=>{const now=getComputedStyle(el).transform;el.style.transition="none";el.style.transform="none";`
  + `const b=el.getBoundingClientRect(),a=src.getBoundingClientRect();el.style.transform=now==="none"?"":now;el.getBoundingClientRect();el.style.transition="";`
  + `if(!b.width)return"";const k=a.width/b.width;return"translate("+(a.left+a.width/2-b.left-b.width*k/2)+"px,"+(a.top+a.height/2-b.top-b.height*k/2)+"px) scale("+k+")"};`
  + `let hidden=null,token=0;const unhide=()=>{if(hidden)hidden.style.visibility="";hidden=null};`
  + `const open=box=>{token++;unhide();const src=still()?null:sourceOf(box);box.toggleAttribute("data-flip",!!src);box.showPopover();const el=body(box);`
  + `if(src&&el){const f=from(el,src);el.style.transition="none";el.style.transform=f;el.getBoundingClientRect();el.style.transition="";el.style.transform="";src.style.visibility="hidden";hidden=src}};`
  + `const leave=box=>{if(box.hasAttribute("data-instant"))return;const el=body(box),src=hidden,n=++token;`
  + `if(src&&el&&!still()&&src.getBoundingClientRect().width){box.setAttribute("data-flip","");el.style.transform=from(el,src);`
  + `el.addEventListener("transitionend",()=>{if(n===token)unhide()},{once:true});setTimeout(()=>{if(n===token)unhide()},450)}else{box.removeAttribute("data-flip");unhide()}`
  + `setTimeout(()=>{if(n===token&&!box.matches(":popover-open")&&el)el.style.transform=""},520)};`
  + `document.querySelectorAll(".lightbox").forEach(b=>b.addEventListener("beforetoggle",e=>{if(e.newState==="closed")leave(b)}));`
  + `const go=b=>{const box=b.closest(".lightbox"),next=document.getElementById(b.getAttribute("popovertarget"));if(!next)return;`
  + `const instant=[box,next].filter(Boolean);instant.forEach(x=>x.setAttribute("data-instant",""));token++;unhide();`
  + `if(box)box.hidePopover();const s=next.dataset.step;if(s&&decodeURIComponent(location.hash.slice(1))!==s)location.hash=encodeURIComponent(s);`
  + `const el=body(next);if(el)el.style.transform="";next.showPopover();const src=sourceOf(next);if(src){src.style.visibility="hidden";hidden=src}`
  + `setTimeout(()=>instant.forEach(x=>x.removeAttribute("data-instant")),60)};`
  + `document.addEventListener("click",e=>{const t=e.target instanceof Element?e.target:null;const b=t&&t.closest(".lb-nav");if(b){e.preventDefault();go(b);return}`
  + `const o=t&&t.closest(".zoom,.enlarge,.gthumb"),lb=o&&document.getElementById(o.getAttribute("popovertarget"));if(lb){e.preventDefault();open(lb);return}`
  + `if(t&&t.classList.contains("lightbox"))t.hidePopover()});`
  + `try{document.querySelectorAll("time[data-local]").forEach(t=>{const d=new Date(t.dateTime);if(isNaN(d.getTime())||!d.getTimezoneOffset())return;`
  + `t.textContent=new Intl.DateTimeFormat(undefined,{...(d.getFullYear()!==d.getUTCFullYear()?{year:"numeric"}:{}),month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"}).format(d);const li=t.closest("[hidden]");if(li)li.hidden=false})}catch{}`
  + `const current=()=>{let el=null;try{el=document.getElementById(decodeURIComponent(location.hash.slice(1)))}catch{}`
  + `const step=el&&el.closest(".step");return step?steps().indexOf(step):0};`
  + `const focused=()=>{const f=document.getElementById("focus-errors");return!!(f&&f.checked)};let last="";`
  + `const reveal=()=>{const i=current();if(i>=0)last=location.hash;const li=document.querySelectorAll(".track li")[i];if(li)li.scrollIntoView({block:"nearest",inline:"nearest"})};`
  + `document.addEventListener("keydown",e=>{if(e.defaultPrevented||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey)return;`
  + `const t=e.target;if(t instanceof HTMLElement&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))return;`
  + `let box=null;try{box=document.querySelector(".lightbox:popover-open")}catch{}`
  + `if(e.key===" "){if(t instanceof Element&&(t.closest("summary")||(t.closest("button")&&!t.closest(".zoom,.enlarge,.lb-nav,.close"))))return;`
  + `e.preventDefault();if(e.repeat)return;if(box){box.hidePopover();return}const i=current(),step=steps()[i<0?-1:i];if(!step)return;`
  + `const base=step.id.replace(/^step-/,"lightbox-");const lb=["--before","--after","--command"].map(r=>document.getElementById(base+r)).find(Boolean);`
  + `if(lb)open(lb);return}`
  + `const d=e.key==="ArrowRight"?1:e.key==="ArrowLeft"?-1:0;if(!d)return;`
  + `if(box){e.preventDefault();const b=box.querySelector(d<0?".lb-nav.prev":".lb-nav.next");if(b)go(b);return}`
  + `const all=steps();let j=current();if(j<0){if(d<0)return;j=-1}`
  + `do j+=d;while(j>=0&&j<all.length&&focused()&&!all[j].classList.contains("err"));`
  + `if(j<0||j>=all.length)return;e.preventDefault();location.hash=encodeURIComponent(all[j].id)});`
  + `const tab=document.querySelector(".tabs .t-traj");if(tab)tab.addEventListener("click",e=>{if(last){e.preventDefault();location.hash=last}});`
  + `addEventListener("hashchange",()=>{let id="";try{id=decodeURIComponent(location.hash.slice(1))}catch{}`
  + `try{document.querySelectorAll(":popover-open").forEach(p=>{if(p.dataset.step!==id)p.hidePopover()})}catch{}reveal()});reveal()})();`;
const keysPolicy = `'sha256-${createHash("sha256").update(keys).digest("base64")}'`;

// Each step's position ties it to its thumbnail.
const selection = (count: number) => !count ? "" : Array.from({ length: count }, (_, i) =>
  `.app:has(.center>.step:nth-of-type(${i + 1}):target) .track li:nth-child(${i + 1}) a`).join(",")
  + ",.app:not(:has(.center :target)) .track li:first-child a{background:var(--s2)}"
  + Array.from({ length: count }, (_, i) => `.app:has(.center>.step:nth-of-type(${i + 1}):target) .track li:nth-child(${i + 1}) .face`).join(",")
  + ",.app:not(:has(.center :target)) .track li:first-child .face{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--accent),0 0 18px var(--ring)}";

export function renderReviewPage(model: ReviewPageModel): string {
  const steps = chronological(model);
  const numbers = new Map(steps.map((step, i) => [step.id, String(i + 1).padStart(2, "0")]));
  const times = steps.map(s => Date.parse(model.details.get(s.id)?.at ?? "")).filter(Number.isFinite);
  const diagnostics = steps.filter(s => s.inputMode === "diagnostic").length, actions = steps.length - diagnostics;
  const errors = steps.filter(erred).length;
  const started = times.length ? new Date(Math.min(...times)).toISOString() : undefined;
  const concerns = new Map<string, Concern[]>();
  for (const [key, label] of [["snapshots", `Snapshots ${model.completeness}`], ["execution", `Execution ${model.execution}`]] as const)
    for (const reason of model.reasons[key]) for (const id of reason.stepIds) concerns.set(id, [...(concerns.get(id) ?? []), { verdict: label, text: reason.text }]);
  const title = /^relay-(.+)-[0-9a-f]{8}$/.exec(model.taskId)?.[1] ?? model.taskId;
  // extractions/<name>/<transfer id>/…: outputs are grouped by their declared
  // name. The transfer id is the relay's own bookkeeping, so a file reads as
  // its guest path under that name.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const byName = new Map<string, { path: string; bytes: number; label: string }[]>();
  for (const output of model.outputs) {
    const [, declared = "", ...rest] = output.path.split("/");
    byName.set(declared, [...(byName.get(declared) ?? []), { ...output, label: rest.filter(part => !uuid.test(part)).join("/") }]);
  }
  const outputBoxes: Box[] = [];
  const outputs = [...byName].map(([declared, files]) => {
    const images = files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f.path)), others = files.filter(f => !images.includes(f));
    const total = files.reduce((sum, f) => sum + f.bytes, 0);
    // A long list of outputs folds each declared name; a short one shows everything.
    return `<details class="group"${model.outputs.length <= 12 ? " open" : ""}><summary><span class="where">${escapeHtml(declared)}</span><span class="count">${plural(files.length, "file")} · ${size(total)}</span></summary>${others.length ? `<ul class="flist">${others.map(f => `<li><a href="${src(f.path)}">${escapeHtml(f.label)}</a><span>${size(f.bytes)}</span></li>`).join("")}</ul>` : ""}${images.length ? `<div class="gallery">${images.map(f => {
      const id = `lightbox-output-${outputBoxes.length + 1}`, name = f.label.split("/").at(-1)!;
      outputBoxes.push({ id, step: "overview", label: declared, title: f.label, nav: name, body: `<img loading="lazy" alt="${escapeHtml(f.label)}, enlarged" src="${src(f.path)}">`, caption: `<span class="file">${escapeHtml(f.label)}</span><span class="size">${size(f.bytes)}</span><a href="${src(f.path)}">Open the original</a>` });
      return `<button type="button" class="gthumb" popovertarget="${id}" title="Enlarge ${escapeHtml(name)}"><img loading="lazy" alt="${escapeHtml(f.label)}" src="${src(f.path)}"><span>${escapeHtml(name)}<small>${size(f.bytes)}</small></span></button>`;
    }).join("")}</div>` : ""}</details>`;
  }).join("");
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
<section class="block"><h3>Package</h3><div class="package"><dl class="ids"><div><dt>Package</dt><dd>${escapeHtml(model.packageId)}</dd></div><div><dt>Task</dt><dd>${escapeHtml(model.taskId)}</dd></div><div><dt>Session</dt><dd>${escapeHtml(model.sessionId)}</dd></div></dl>
<ul class="files"><li><a href="manifest.json">manifest.json</a><span>Checksums of every artifact</span></li><li><a href="summary.json">summary.json</a><span>Verdicts and findings</span></li><li><a href="trajectory.json">trajectory.json</a><span>Steps as recorded</span></li></ul></div></section></div></section></article>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; script-src ${keysPolicy}; base-uri 'none'; form-action 'none'"><title>Relay review: ${escapeHtml(model.packageId)}</title><style>${css}${selection(steps.length)}</style></head><body>
<div class="app">
<header class="top"><div class="brand"><span class="mark" aria-hidden="true">${relayMark}</span><h1 title="${escapeHtml(model.packageId)}">Relay<span class="task">${escapeHtml(title)}</span></h1>
<ul class="stats">${stat(noun(steps.length, "step"), String(steps.length))}${stat(noun(actions, "action"), String(actions))}${stat(noun(diagnostics, "diagnostic"), String(diagnostics))}${started ? `<li class="at"><time datetime="${started}" title="Started ${started}">${utcStamp(started)}</time><span class="local" hidden><span class="sep" aria-hidden="true">·</span><time datetime="${started}" data-local title="Started, in your time zone"></time></span></li>` : ""}${times.length ? stat("", duration(Math.max(...times) - Math.min(...times))) : ""}</ul></div>
<div class="mid"><nav class="tabs" aria-label="View"><a class="t-traj" href="${steps[0] ? escapeHtml(link(steps[0])) : "#"}">Trajectory</a><a class="t-over" href="#overview">Overview<span class="${model.findings.length ? "has" : ""}">${model.findings.length}</span></a></nav>
<label class="focus" title="Highlight the steps with errors, and move between them with the arrows"><input type="checkbox" id="focus-errors"${errors ? "" : " disabled"}>Focus on errors<span>${errors}</span></label></div>
<ul class="pills"><li class="keys" title="Keyboard shortcuts"><kbd aria-label="Left arrow">←</kbd><kbd aria-label="Right arrow">→</kbd><span>Steps</span><kbd>Space</kbd><span>Enlarge</span></li>${pill("snapshots", "Snapshots", model.completeness)}${pill("execution", "Execution", model.execution)}</ul></header>
<main class="center">${steps.map((step, i) => `<article id="step-${escapeHtml(step.id)}" class="step ${tone(step.execution)}${erred(step) ? " err" : ""}">${stage(step, model.details.get(step.id), numbers.get(step.id)!, {
    previous: steps[i - 1], next: steps[i + 1], previousError: steps.slice(0, i).findLast(erred), nextError: steps.slice(i + 1).find(erred) })}${panel(step, model.details.get(step.id), numbers.get(step.id)!, steps.length, concerns.get(step.id) ?? [])}</article>`).join("\n")}
${overview}</main>
<footer class="track" aria-label="Steps"><ol>${steps.map(step => thumb(step, model.details.get(step.id), numbers.get(step.id)!, concerns.has(step.id))).join("")}</ol></footer>
</div>
${lightboxes(trajectoryBoxes(steps, model, numbers))}
${lightboxes(outputBoxes)}
<script>${keys}</script></body></html>
`;
}

// Design (docs/ux-design.md §6.10): light, warm, minimal and vivid. A warm
// ivory canvas with white surfaces on soft warm shadows, one vermilion-to-
// marigold accent, round shapes, and separation by space and tone rather than
// borders. Status uses four vivid tones, each with its word.
const css = `:root{color-scheme:light;--bg:#fbf6ef;--s1:#ffffff;--s2:#f7efe5;--s3:#efe3d5;--hair:rgba(90,50,20,.08);--text:#2a1d15;--dim:#5e4b3e;--faint:#7d6a5c;
--accent:#f0502a;--accent2:#ff9f1a;--grad:linear-gradient(135deg,var(--accent),var(--accent2));--on:#fff;--ring:rgba(240,80,42,.28);
--ok:#0e9f62;--bad:#e23744;--warn:#b87700;--shadow:0 1px 2px rgba(90,50,20,.06),0 12px 32px rgba(90,50,20,.10);
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
.top{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:start;gap:1rem .75rem;padding:1.1rem 1.5rem}
.brand{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:.45rem .75rem;min-width:0}.brand .stats{grid-column:1/-1;margin:0}
.mark{flex:none;display:grid;place-items:center;width:2.15rem;height:2.15rem;border-radius:11px;background:linear-gradient(145deg,#ffb23d,var(--accent) 70%);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),inset 0 -2px 6px rgba(160,40,10,.18),0 6px 18px var(--ring)}
h1{display:flex;align-items:baseline;gap:.6rem;font:700 1.3rem/1.15 var(--round);letter-spacing:-.015em;margin:0}
h1 .task{font:600 12.5px/1 var(--round);letter-spacing:0;padding:.3rem .6rem;border-radius:999px;background:var(--s2);color:var(--dim);align-self:center}
.stats .at time{font:600 12px var(--round);color:var(--text)}.stats .at .sep{margin:0 .4rem}
.stats{display:flex;flex-wrap:wrap;gap:.15rem .8rem;list-style:none;margin:.3rem 0 0;padding:0;font-size:12px;color:var(--faint)}.stats b{font:700 12px var(--round);color:var(--text)}
.pills{justify-self:end;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:.3rem;list-style:none;margin:0;padding:0}.pills>li,.stats>li{white-space:nowrap}
.pill{display:flex;align-items:center;gap:.4rem;padding:.42rem .7rem;border-radius:999px;background:color-mix(in srgb,var(--tone) 12%,transparent);font-size:12px;color:var(--dim)}
.brand,.pills{margin-top:.2rem}.mid{justify-self:center;display:grid;justify-items:center;gap:.35rem}
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
.concern{margin-top:1.1rem;padding:.9rem 1rem;border-radius:14px;background:color-mix(in srgb,var(--warn) 10%,var(--s1))}.concern h3{margin:0 0 .55rem;color:var(--warn)}
.concern ul{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}.concern li{display:grid;gap:.2rem}.concern .label{color:var(--warn)}.concern p{margin:0;color:var(--text);font-size:13.5px;line-height:1.5}
.vblock{padding:.95rem 1.1rem;border-radius:14px;background:var(--s1);box-shadow:var(--shadow)}.vblock+.vblock{margin-top:.6rem}
.vblock h4{display:flex;align-items:center;gap:.7rem;margin:0 0 .5rem;font:700 14px var(--round)}.vwhy{margin:0 0 .6rem;font-size:12.5px;color:var(--faint)}.vblock>.quiet{font-size:13.5px}
.face{position:relative}.took{position:absolute;top:.35rem;left:.35rem;padding:.18rem .45rem;border-radius:999px;background:rgba(42,29,21,.72);color:#fff;font:700 10.5px/1 var(--round);backdrop-filter:blur(4px)}.flag{position:absolute;top:.35rem;right:.35rem;display:grid;place-items:center;width:1.1rem;height:1.1rem;border-radius:50%;background:var(--warn);color:#fff;font:800 11px/1 var(--round);box-shadow:0 2px 6px rgba(0,0,0,.2)}
.focus{display:flex;align-items:center;gap:.45rem;padding:.3rem .6rem;border-radius:999px;font-size:12px;font-weight:600;color:var(--dim);cursor:pointer;user-select:none}
.focus:hover{background:var(--s2)}.focus input{appearance:none;margin:0;width:1.05rem;height:1.05rem;border-radius:6px;background:var(--s1);box-shadow:inset 0 0 0 1.5px var(--faint);display:grid;place-items:center;cursor:pointer}
.focus input:checked{background:var(--bad);box-shadow:none}.focus input:checked::after{content:"";width:.28rem;height:.55rem;border:solid #fff;border-width:0 2px 2px 0;rotate:45deg;translate:0 -1px}
.focus input:disabled,.focus:has(input:disabled){cursor:default;opacity:.55}.focus span{font:700 11px/1 var(--round);color:var(--bad)}.focus:has(input:disabled) span{color:var(--faint)}
.app:has(#focus-errors:checked) .track li:not(.err){opacity:.35;filter:grayscale(1)}
.app:has(#focus-errors:checked) .track li.err .face{box-shadow:0 0 0 2px var(--bad),0 6px 16px color-mix(in srgb,var(--bad) 25%,transparent)}
.app:has(#focus-errors:checked) .track li.err .t{color:var(--bad)}
.app:has(#overview:target) .track{display:none}.app:has(#overview:target) .focus{visibility:hidden}.app:has(#overview:target) .keys{display:none}
.keys{display:flex;align-items:center;gap:.25rem;margin-right:.4rem;font-size:11px;color:var(--faint)}.keys span{margin:0 .35rem 0 .1rem}.keys span:last-child{margin-right:0}
kbd{display:inline-grid;place-items:center;min-width:1.3rem;height:1.3rem;padding:0 .3rem;border-radius:6px;background:var(--s1);box-shadow:0 0 0 1px var(--hair),0 1.5px 0 var(--s3);font:600 10.5px/1 var(--sans);color:var(--dim)}.overview>.doc{grid-area:auto;grid-column:1/-1;grid-row:1}
.center{display:grid;grid-template-columns:minmax(0,1fr) minmax(20rem,25rem);grid-template-areas:"stage panel";gap:0 .75rem;padding:0 .75rem;min-height:0;position:relative;z-index:1}
.step{display:none}.step:target{display:contents}.center:not(:has(:target))>.step:first-of-type{display:contents}
.stage{grid-area:stage;position:relative;min-width:0;min-height:0;background:var(--bg);display:grid;grid-template-rows:minmax(0,1fr);overflow:clip}
.pair{min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;align-items:center;padding:1.25rem 4.75rem 1.4rem}
.shot{margin:0;min-height:0;min-width:0;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:.7rem}
.zoom{all:unset;display:grid;place-items:center;min-height:0;cursor:zoom-in;border-radius:12px}.zoom:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.shot img{max-width:100%;max-height:100%;object-fit:contain;border-radius:12px;box-shadow:0 2px 4px rgba(60,30,10,.08),0 18px 44px rgba(60,30,10,.16);background:#fff;transition:box-shadow .15s}
.zoom:hover img{box-shadow:0 0 0 2px var(--accent),0 18px 44px rgba(60,30,10,.18)}
.shot figcaption{display:flex;justify-content:center;gap:.7rem;align-items:baseline}.shot figcaption time{font:12px var(--mono);color:var(--faint)}
.pair .shot:last-child figcaption .label{color:var(--accent)}
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
.terminal{grid-template-rows:minmax(0,1fr);place-items:center;padding:2rem 4.75rem}
.term{width:min(100%,56rem);max-height:100%;overflow:auto;background:var(--s1);border-radius:18px;box-shadow:var(--shadow)}
.term-bar{display:flex;align-items:center;gap:1rem;padding:.8rem 1.1rem;font-size:12px;color:var(--faint);position:sticky;top:0;background:var(--s1)}
.dots{display:flex;gap:.35rem}.dots i{width:10px;height:10px;border-radius:50%;background:var(--s3)}.dots i:first-child{background:var(--grad)}
.term-cmd{padding:.4rem 1.2rem 1.1rem;font-size:13px;color:var(--text)}.prompt{color:var(--accent);margin-right:.6em;user-select:none}
.term .stream{margin:0 1.2rem 1rem}.term .quiet,.term-note{margin:0 1.2rem 1.1rem;font-size:12.5px;color:var(--faint)}
.stream .label{display:block;margin-bottom:.35rem}.stream pre,.plain,.command{background:var(--s2);border-radius:12px;padding:.75rem .9rem;max-height:14rem;overflow:auto;color:var(--text)}
.panel{grid-area:panel;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;background:var(--s1);border-radius:22px;box-shadow:var(--shadow)}
.panel-scroll{overflow:auto;padding:1.5rem 1.5rem 1.25rem;scrollbar-width:thin;scrollbar-color:var(--s3) transparent}
.eyebrow{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .9rem;margin:0;font-size:12px;color:var(--faint)}
.eyebrow>span:first-child{font:700 12.5px var(--round);background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}.eyebrow .of{-webkit-text-fill-color:var(--faint);color:var(--faint);font-weight:500}.eyebrow time{font-family:var(--mono)}
.permalink{margin-left:auto;display:grid;place-items:center;width:1.9rem;height:1.9rem;margin-block:-.4rem;border-radius:999px;color:var(--faint)}.permalink:hover{background:var(--s2);color:var(--accent)}
.panel h2{font:700 1.3rem/1.3 var(--round);letter-spacing:-.01em;margin:.5rem 0 .55rem;overflow-wrap:anywhere}
.state{margin:0}
.block{margin-top:1.5rem}.block h3{margin:0 0 .45rem}.block p{margin:0;color:var(--dim)}
.command{font-size:12px;max-height:9rem}
.receipts{list-style:none;margin:0 0 .4rem;padding:0;display:grid;gap:.45rem}.receipts li{display:flex;flex-wrap:wrap;gap:.4rem .8rem;align-items:center}.diag{font-size:13px;color:var(--dim)}
.exit{display:inline-block;font:700 11.5px var(--mono);padding:.25rem .6rem;border-radius:999px;margin-bottom:.55rem}
.exit.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 15%,transparent)}.exit.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 15%,transparent)}
.receipts .exit{margin:0}.stream{margin-bottom:.6rem}
.raw summary{cursor:pointer;font-size:12px;color:var(--faint);width:max-content}.raw summary:hover{color:var(--dim)}.raw pre{margin-top:.5rem;color:var(--faint);font-size:11.5px;max-height:12rem;overflow:auto}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:.9rem 1rem;margin:1.5rem 0 0;padding:1rem 1.1rem;border-radius:14px;background:var(--s2)}.facts dd{margin:.2rem 0 0;font:12.5px var(--mono);color:var(--dim);overflow-wrap:anywhere}
.facts.stack{grid-template-columns:1fr}
.files{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}.files li{display:grid}.files a{font:12.5px var(--mono)}.files span{font-size:12px;color:var(--faint)}
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
.doc .files{gap:.9rem}.doc .files a{font-size:.875rem}.doc .files span{font-size:.8125rem}
@media(max-width:960px){.package{grid-template-columns:minmax(0,1fr)}}
.findings{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}.findings li{padding:.8rem 1rem;border-radius:14px;background:var(--s1);box-shadow:var(--shadow)}
.findings summary{cursor:pointer}.findings code{display:block;font:11.5px/1.6 var(--mono);color:var(--faint);margin-top:.4rem;overflow-wrap:anywhere}
.outputs{display:grid;gap:.5rem}.group{background:var(--s1);border-radius:14px;padding:.75rem 1rem;box-shadow:var(--shadow)}
.group summary{display:flex;justify-content:space-between;gap:1rem;cursor:pointer;font-size:13px;list-style:none}.group summary::-webkit-details-marker{display:none}
.group summary{align-items:center}.group .where{display:inline-flex;align-items:center;gap:.7rem;font-weight:600}
.group .where::before{content:"";flex:none;width:.4rem;height:.4rem;border:solid var(--accent);border-width:0 1.5px 1.5px 0;rotate:-45deg;transition:rotate .15s}.group[open] .where::before{rotate:45deg}.group .count{color:var(--faint);flex:none}
.group[open] summary{margin-bottom:.75rem}
.flist{list-style:none;margin:0;padding:0;display:grid;gap:.3rem;font:12px var(--mono);max-height:16rem;overflow:auto}.flist li{display:flex;justify-content:space-between;gap:1rem}.flist a{overflow-wrap:anywhere;min-width:0}.flist span{color:var(--faint);flex:none}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:.75rem}.flist+.gallery{margin-top:.75rem}
.gthumb{all:unset;box-sizing:border-box;cursor:zoom-in;display:grid;gap:.4rem;font:11.5px var(--mono);min-width:0;color:var(--dim)}.gthumb span{display:flex;justify-content:space-between;gap:.5rem;overflow:hidden;white-space:nowrap}.gthumb small{color:var(--faint);font-size:inherit;flex:none}
.gthumb img{width:100%;aspect-ratio:16/9;object-fit:contain;border-radius:10px;display:block;background:var(--s2);box-shadow:inset 0 0 0 1px var(--hair);transition:box-shadow .15s}.gthumb:hover img,.gthumb:focus-visible img{box-shadow:0 0 0 2px var(--accent)}
.track ol{min-width:0;list-style:none;margin:0;padding:.75rem 1.75rem 1rem;display:flex;gap:.6rem;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--s3) transparent}
.track li{flex:none;width:9.25rem}
.track a{display:grid;gap:.45rem;padding:.35rem;border-radius:16px;color:var(--text);transition:background .15s}
.track a:hover{text-decoration:none;background:var(--s1)}
.face{display:block;aspect-ratio:16/9;border-radius:11px;overflow:hidden;background:var(--s1);box-shadow:0 1px 2px rgba(90,50,20,.08),0 6px 16px rgba(90,50,20,.08)}
.face img{width:100%;height:100%;object-fit:cover;display:block}
.face.text pre{padding:.55rem .6rem;font-size:9.5px;line-height:1.45;color:var(--dim);height:100%;overflow:hidden;-webkit-mask-image:linear-gradient(#000 60%,transparent);mask-image:linear-gradient(#000 60%,transparent)}
.cap{display:flex;align-items:center;gap:.4rem;min-width:0;padding:0 .2rem;font-size:12px}
.cap .n{font:600 11px var(--mono);color:var(--faint)}.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--tone)}
.cap .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim)}
.track li.bad .face{box-shadow:0 0 0 2px var(--bad)}
@media(max-width:960px){.top{grid-template-columns:minmax(0,1fr)}.pills{justify-self:center;justify-content:center}.app{height:auto;min-height:100vh;overflow:visible}.center{grid-template-columns:minmax(0,1fr);grid-template-areas:"stage" "panel";gap:.75rem}
.stage{min-height:60vh}.pair{padding:.5rem 3.75rem 1rem;grid-template-columns:1fr}.track{position:sticky;bottom:0;background:var(--bg)}}
@supports (corner-shape:squircle){*,*::before,*::after,::backdrop{corner-shape:squircle}.dot,.verdict i,.arrow,.q,.flag,.close,.dots i,.lb-nav .dir,
:focus-visible,h1 .task,.pill,.tabs,.tabs a,.tabs a span,.reasons .steps a,.took,.focus,.lb-cap,.lb-nav,.enlarge,.permalink,.exit{corner-shape:round}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media print{.app{height:auto;display:block}.track,.arrow,.mid,.lightbox,.enlarge{display:none}.center{display:block}.step{display:block!important;break-inside:avoid;margin-bottom:1rem}.stage{background:none}}`;
