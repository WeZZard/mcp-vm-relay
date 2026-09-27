// The offline review page (index.html) of a delivered evidence package.
//
// The page is a pure function of the package's retained evidence: delivery
// writes it once, and verification renders it again and requires the same
// bytes. It therefore reads no clock, no environment and no file beyond the
// model it is given. It opens from file:// under a policy that forbids
// scripts, so every interaction is a plain link, an anchor or <details>.
// The visual design is specified in docs/ux-design.md §6.10.

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

export interface ReviewPageModel {
  packageId: string;
  sessionId: string;
  taskId: string;
  completeness: string;
  execution: string;
  findings: string[];
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
const size = (bytes: number) => bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes >= 1e3 ? `${(bytes / 1e3).toFixed(1)} kB` : `${bytes} B`;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
/** Status is carried by one of four tones, and always shown with its word. */
const tone = (value: string) => ["passed", "complete", "completed"].includes(value) ? "ok"
  : ["failed", "refused"].includes(value) ? "bad" : value === "pending" ? "pend" : "warn";
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

/** One snapshot, fitted to the viewport. */
function shot(step: ReviewPageStep, detail: StepDetail | undefined, role: "before" | "after") {
  const path = step.snapshots?.[role];
  const name = role === "before" ? "Before" : "After";
  const at = preciseTime(role === "before" ? detail?.beforeAt : detail?.afterAt);
  const caption = `<figcaption><span class="label">${name}</span>${at ? `<time>${at}</time>` : ""}</figcaption>`;
  if (!path) return `<figure class="shot missing"><div class="void">${name}: unavailable — incomplete evidence</div>${caption}</figure>`;
  return `<figure class="shot"><a href="${src(path)}" title="Open the original snapshot"><img alt="${name} dispatch snapshot" src="${src(path)}"></a>${caption}</figure>`;
}

/** The viewport of a step: its snapshots, with a switch between after, before and both; or its command. */
function stage(step: ReviewPageStep, detail: StepDetail | undefined, number: string, previous?: ReviewPageStep, next?: ReviewPageStep) {
  const { headline, command } = describe(step, detail);
  const arrows = `${previous ? `<a class="arrow prev" href="${escapeHtml(link(previous))}" aria-label="Previous step">‹</a>` : ""}${next ? `<a class="arrow next" href="${escapeHtml(link(next))}" aria-label="Next step">›</a>` : ""}`;
  if (!step.snapshots) {
    return `<section class="stage terminal" aria-label="Step ${number} command">${arrows}<div class="term"><div class="term-bar"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${step.inputMode === "diagnostic" ? "Diagnostic command" : "Command"} · no snapshots</span></div>
<pre class="term-cmd"><span class="prompt" aria-hidden="true">$</span>${escapeHtml(command ?? headline)}</pre>${detail?.output ? streamsOf(detail.output) || `<p class="quiet">No output.</p>` : ""}
<p class="term-note">${step.inputMode === "diagnostic" ? "Screenshots were not requested for this diagnostic." : "No snapshots were captured for this step."}</p></div></section>`;
  }
  const gap = detail?.beforeAt && detail.afterAt ? `+${duration(Date.parse(detail.afterAt) - Date.parse(detail.beforeAt))}` : undefined;
  const id = `step-${step.id}`, href = (suffix: string) => escapeHtml(`#${encodeURIComponent(`${id}${suffix}`)}`);
  return `<section class="stage" aria-label="Step ${number} snapshots">
<nav class="seg" aria-label="Snapshot view"><a class="s-after" href="${escapeHtml(link(step))}">After</a><a class="s-before" href="${href("--before")}">Before</a><a class="s-compare" href="${href("--compare")}">Compare</a>${gap ? `<span class="gap" title="Time between the before and after snapshots">${gap}</span>` : ""}</nav>
${arrows}<div class="views"><div class="view v-after">${shot(step, detail, "after")}</div><div class="view v-before" id="${escapeHtml(`${id}--before`)}">${shot(step, detail, "before")}</div><div class="view v-compare" id="${escapeHtml(`${id}--compare`)}">${shot(step, detail, "before")}${shot(step, detail, "after")}</div></div></section>`;
}

/** The right panel of a step: what it was, why it was sent, and what came back. */
function panel(step: ReviewPageStep, detail: StepDetail | undefined, number: string, total: number, previous?: ReviewPageStep, next?: ReviewPageStep) {
  const { headline, command, reasonShown, kind } = describe(step, detail);
  const interval = step.snapshots?.declaredAfterIntervalMs;
  const at = time(detail?.at);
  const fact = (term: string, value: string) => `<div><dt>${term}</dt><dd>${value}</dd></div>`;
  return `<aside class="panel" aria-label="Step ${number} details"><div class="panel-scroll">
<p class="eyebrow"><span>Step ${number} <span class="of">of ${String(total).padStart(2, "0")}</span></span><span>${kind}</span>${at ? `<time>${at} UTC</time>` : ""}</p>
<h2>${escapeHtml(headline)}</h2><p class="state"><span class="sr">Execution: </span>${verdict(step.execution)}</p>
${reasonShown ? `<section class="block"><h3>Reason</h3><p>${escapeHtml(step.because ?? "Not present in retained host metadata")}</p></section>` : ""}
${command && step.snapshots ? `<section class="block"><h3>Command</h3><pre class="command">${escapeHtml(command)}</pre></section>` : ""}
<section class="block"><h3>Expected</h3><p>${escapeHtml(step.expected || "Not supplied")}</p></section>
<section class="block"><h3>Observed</h3>${observed(step, detail?.output, !!step.snapshots)}</section>
<dl class="facts">${fact("State", escapeHtml(step.state))}${fact("Input", escapeHtml(step.inputMode))}${fact("After interval", interval === undefined ? "unavailable" : `${interval} ms`)}${step.snapshots?.groupId ? fact("Group", escapeHtml(step.snapshots.groupId)) : ""}</dl>
</div><nav class="pager" aria-label="Step ${number}">${previous ? `<a href="${escapeHtml(link(previous))}">‹ Previous</a>` : `<span class="off">‹ Previous</span>`}<a class="stable" href="${escapeHtml(link(step))}">Stable link</a>${next ? `<a href="${escapeHtml(link(next))}">Next ›</a>` : `<span class="off">Next ›</span>`}</nav></aside>`;
}

/** One thumbnail of the bottom track: the step's after snapshot, or its command. */
function thumb(step: ReviewPageStep, detail: StepDetail | undefined, number: string) {
  const { headline, command } = describe(step, detail);
  const image = step.snapshots?.after ?? step.snapshots?.before;
  const face = image ? `<img loading="lazy" alt="" src="${src(image)}">` : `<pre aria-hidden="true"><span class="prompt">$</span>${escapeHtml(command ?? headline)}</pre>`;
  return `<li class="${tone(step.execution)}${step.inputMode === "diagnostic" ? " diagnostic" : ""}"><a href="${escapeHtml(link(step))}" title="${escapeHtml(headline)}"><span class="face${image ? "" : " text"}">${face}</span><span class="cap"><span class="n">${number}</span><i class="dot" aria-hidden="true"></i><span class="t">${escapeHtml(headline)}</span></span><span class="sr">${escapeHtml(step.execution)}</span></a></li>`;
}

// Without script, the selected step is the :target. Each rule below ties a
// step's position to its thumbnail; with no target, the first step shows.
// :has() cannot nest, so a step's own target and a target inside it (its
// before or compare view) are two selectors.
const selection = (count: number) => !count ? "" : Array.from({ length: count }, (_, i) =>
  `.app:has(.center>.step:nth-of-type(${i + 1}):target) .track li:nth-child(${i + 1}) a,.app:has(.center>.step:nth-of-type(${i + 1}) :target) .track li:nth-child(${i + 1}) a`).join(",")
  + ",.app:not(:has(.center :target)) .track li:first-child a{border-color:var(--accent);box-shadow:0 0 0 3px var(--ring);background:var(--s2)}";

export function renderReviewPage(model: ReviewPageModel): string {
  const steps = chronological(model);
  const numbers = new Map(steps.map((step, i) => [step.id, String(i + 1).padStart(2, "0")]));
  const times = steps.map(s => Date.parse(model.details.get(s.id)?.at ?? "")).filter(Number.isFinite);
  const diagnostics = steps.filter(s => s.inputMode === "diagnostic").length, actions = steps.length - diagnostics;
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
  const outputs = [...byName].map(([declared, files]) => {
    const images = files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f.path)), others = files.filter(f => !images.includes(f));
    const total = files.reduce((sum, f) => sum + f.bytes, 0);
    // A long list of outputs folds each declared name; a short one shows everything.
    return `<details class="group"${model.outputs.length <= 12 ? " open" : ""}><summary><span class="where">${escapeHtml(declared)}</span><span class="count">${plural(files.length, "file")} · ${size(total)}</span></summary>${others.length ? `<ul class="flist">${others.map(f => `<li><a href="${src(f.path)}">${escapeHtml(f.label)}</a><span>${size(f.bytes)}</span></li>`).join("")}</ul>` : ""}${images.length ? `<div class="gallery">${images.map(f => `<a class="gthumb" href="${src(f.path)}"><img loading="lazy" alt="${escapeHtml(f.label)}" src="${src(f.path)}"><span>${escapeHtml(f.label.split("/").at(-1))}<small>${size(f.bytes)}</small></span></a>`).join("")}</div>` : ""}</details>`;
  }).join("");
  const stat = (label: string, value: string) => `<li><b>${value}</b><span>${label}</span></li>`;
  const pill = (label: string, value: string) => `<li class="pill ${tone(value)}"><span>${label}</span>${verdict(value)}</li>`;
  const overview = `<article class="step overview" id="overview"><section class="stage doc" aria-label="Package overview"><div class="doc-in">
<h2>Overview</h2><p class="lede">Delivery integrity is separate from execution success. Snapshots are dispatch-time evidence, not continuous video: each shows the screen just before a step was sent and shortly after it returned.</p>
<section class="block"><h3>Findings · ${model.findings.length}</h3>${model.findings.length ? `<ul class="findings">${groupFindings(model.findings).map(g => `<li>${g.ids.length ? `<details><summary>${escapeHtml(g.text)}</summary><code>${g.ids.map(escapeHtml).join("<br>")}</code></details>` : escapeHtml(g.text)}</li>`).join("")}</ul>` : `<p class="quiet">No findings.</p>`}</section>
<section class="block"><h3>Declared outputs · ${model.outputs.length}</h3>${outputs ? `<div class="outputs">${outputs}</div>` : `<p class="quiet">No declared outputs were delivered.</p>`}</section></div></section>
<aside class="panel" aria-label="Package"><div class="panel-scroll"><p class="eyebrow"><span>Package</span></p><h2>${escapeHtml(title)}</h2>
<dl class="facts stack"><div><dt>Package</dt><dd>${escapeHtml(model.packageId)}</dd></div><div><dt>Task</dt><dd>${escapeHtml(model.taskId)}</dd></div><div><dt>Session</dt><dd>${escapeHtml(model.sessionId)}</dd></div></dl>
<section class="block"><h3>Files</h3><ul class="files"><li><a href="manifest.json">manifest.json</a><span>Checksums of every artifact</span></li><li><a href="summary.json">summary.json</a><span>Verdicts and findings</span></li><li><a href="trajectory.json">trajectory.json</a><span>Steps as recorded</span></li></ul></section>
<section class="block"><h3>Human review</h3><p>Pending. The relay does not review its own evidence; these verdicts come from retained records only.</p></section></div>
<nav class="pager">${steps[0] ? `<a href="${escapeHtml(link(steps[0]))}">Start at step 01 ›</a>` : "<span></span>"}</nav></aside></article>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Relay review: ${escapeHtml(model.packageId)}</title><style>${css}${selection(steps.length)}</style></head><body>
<div class="app">
<header class="top"><div class="brand"><span class="mark" aria-hidden="true"></span><div><h1>${escapeHtml(title)}</h1><p class="pkg">${escapeHtml(model.packageId)}</p></div></div>
<ul class="stats">${stat("steps", String(steps.length))}${stat("actions", String(actions))}${stat("diagnostics", String(diagnostics))}${times.length ? `${stat("UTC start", time(new Date(Math.min(...times)).toISOString())!)}${stat("span", duration(Math.max(...times) - Math.min(...times)))}` : ""}</ul>
<ul class="pills">${pill("Snapshots", model.completeness)}${pill("Execution", model.execution)}${pill("Review", "pending")}</ul>
<a class="ovl${model.findings.length ? " has" : ""}" href="#overview">Overview<span>${model.findings.length}</span></a></header>
<main class="center">${steps.map((step, i) => `<article id="step-${escapeHtml(step.id)}" class="step ${tone(step.execution)}">${stage(step, model.details.get(step.id), numbers.get(step.id)!, steps[i - 1], steps[i + 1])}${panel(step, model.details.get(step.id), numbers.get(step.id)!, steps.length, steps[i - 1], steps[i + 1])}</article>`).join("\n")}
${overview}</main>
<footer class="track" aria-label="Steps"><ol>${steps.map(step => thumb(step, model.details.get(step.id), numbers.get(step.id)!)).join("")}</ol></footer>
</div></body></html>
`;
}

// Design (docs/ux-design.md §6.10): a warm, quiet workspace. Three rows —
// the run, the selected step, and the track of steps. Snapshots sit on the
// darkest surface so they read as the brightest thing on the page; status
// uses four tones, each with its word.
const css = `:root{color-scheme:dark;--bg:#171412;--s1:#1f1b18;--s2:#29231f;--s3:#332c27;--line:#3a322c;--line2:#4a4039;--text:#f4ede5;--dim:#c3b7aa;--faint:#9d9185;
--accent:#ff9d5c;--ring:rgba(255,157,92,.28);--stage:#0f0d0c;--glow:rgba(255,157,92,.07);--ok:#93d49a;--bad:#ff8170;--warn:#f4c35e;--pend:#e7a9c0;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--round:ui-rounded,"SF Pro Rounded",var(--sans);--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f0e8;--s1:#fffaf4;--s2:#f3eadf;--s3:#eadfd2;--line:#e4d8ca;--line2:#d3c4b3;--text:#2b211b;--dim:#62544a;--faint:#7a6b5f;
--accent:#c9561d;--ring:rgba(201,86,29,.22);--stage:#e9e0d5;--glow:rgba(201,86,29,.06);--ok:#2e7d45;--bad:#c23b2a;--warn:#946100;--pend:#a0466f}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14.5px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
pre{font:12.5px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
b,time,.n,.exit,dd,.gap{font-variant-numeric:tabular-nums}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.label,h3,dt{font:600 11px/1.3 var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
.quiet{color:var(--faint);margin:0}
.ok{--tone:var(--ok)}.bad{--tone:var(--bad)}.warn{--tone:var(--warn)}.pend{--tone:var(--pend)}
.verdict{display:inline-flex;align-items:center;gap:.4rem;font:600 12.5px/1 var(--sans);color:var(--tone,var(--dim));text-transform:capitalize}
.verdict i{flex:none;width:7px;height:7px;border-radius:50%;background:currentColor}
.app{height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;grid-template-columns:minmax(0,1fr);overflow:clip}.track{min-width:0}
.top{display:flex;align-items:center;gap:1.5rem 2rem;flex-wrap:wrap;padding:.85rem 1.5rem;border-bottom:1px solid var(--line);background:var(--s1)}
.brand{display:flex;align-items:center;gap:.8rem;min-width:0;margin-right:auto}
.mark{flex:none;width:2.1rem;height:2.1rem;border-radius:10px;background:radial-gradient(circle at 30% 30%,#ffd29a,var(--accent) 55%,#c2410c);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
h1{font:650 1.2rem/1.2 var(--round);letter-spacing:-.01em;margin:0}.pkg{margin:.1rem 0 0;font:12px var(--mono);color:var(--faint)}
.stats{display:flex;gap:1.6rem;list-style:none;margin:0;padding:0}.stats li{display:grid}.stats b{font:650 1.05rem/1.2 var(--round)}.stats span{font-size:11.5px;color:var(--faint)}
.pills{display:flex;gap:.5rem;list-style:none;margin:0;padding:0}
.pill{display:flex;align-items:center;gap:.55rem;padding:.4rem .7rem;border-radius:999px;background:var(--s2);border:1px solid var(--line);font-size:12px;color:var(--dim)}
.pill .verdict{font-size:12px}
.ovl{display:inline-flex;align-items:center;gap:.5rem;padding:.45rem .8rem;border-radius:999px;border:1px solid var(--line2);color:var(--text);font-weight:600;font-size:13px}
.ovl span{font:650 11px/1 var(--round);padding:.2rem .45rem;border-radius:999px;background:var(--s3);color:var(--dim)}.ovl.has span{background:var(--warn);color:#2b1d05}
.ovl:hover{text-decoration:none;border-color:var(--accent)}.app:has(#overview:target) .ovl{border-color:var(--accent);box-shadow:0 0 0 3px var(--ring)}
.center{display:grid;grid-template-columns:minmax(0,1fr) minmax(20rem,26rem);grid-template-areas:"stage panel";min-height:0;overflow:clip}
.step{display:none}.step:is(:target,:has(:target)){display:contents}.center:not(:has(:target))>.step:first-of-type{display:contents}
.stage{grid-area:stage;position:relative;min-width:0;min-height:0;background:radial-gradient(ellipse at 50% 40%,var(--glow),transparent 70%),var(--stage);display:grid;grid-template-rows:auto minmax(0,1fr);overflow:clip}
.seg{display:flex;align-items:center;gap:.25rem;justify-self:center;margin:.9rem 0 .2rem;padding:.25rem;border-radius:999px;background:var(--s1);border:1px solid var(--line);z-index:2}
.seg a{padding:.3rem .85rem;border-radius:999px;color:var(--dim);font-size:12.5px;font-weight:600}.seg a:hover{text-decoration:none;color:var(--text)}
.seg .gap{font:600 11.5px var(--round);color:var(--faint);padding:0 .6rem 0 .5rem}
.step:target .s-after,.center:not(:has(:target))>.step:first-of-type .s-after,.step:has(.v-before:target) .s-before,.step:has(.v-compare:target) .s-compare{background:var(--s3);color:var(--text)}
.views{min-height:0;display:grid;padding:.6rem 4.5rem 1.2rem;overflow:clip}
.view{display:none;min-height:0}
.step:target .v-after,.center:not(:has(:target))>.step:first-of-type .v-after,.v-before:target{display:grid}
.v-compare:target{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.shot{margin:0;min-height:0;min-width:0;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:.55rem}
.shot a{display:grid;place-items:center;min-height:0}
.shot img{max-width:100%;max-height:100%;object-fit:contain;border-radius:10px;box-shadow:0 1px 0 rgba(255,255,255,.05),0 18px 50px rgba(0,0,0,.45);background:#000}
.shot figcaption{display:flex;justify-content:center;gap:.8rem;align-items:baseline}.shot figcaption time{font:12px var(--mono);color:var(--faint)}
.void{display:grid;place-items:center;border:1px dashed var(--line2);border-radius:10px;color:var(--faint);padding:2rem;text-align:center}
.arrow{position:absolute;top:50%;translate:0 -50%;z-index:3;display:grid;place-items:center;width:2.6rem;height:2.6rem;border-radius:50%;background:var(--s1);border:1px solid var(--line);color:var(--text);font-size:1.5rem;line-height:1}
.arrow:hover{text-decoration:none;border-color:var(--accent);color:var(--accent)}.arrow.prev{left:1rem}.arrow.next{right:1rem}
.terminal{grid-template-rows:minmax(0,1fr);place-items:center;padding:2rem 4.5rem}
.term{width:min(100%,56rem);max-height:100%;overflow:auto;background:var(--s1);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.35)}
.term-bar{display:flex;align-items:center;gap:1rem;padding:.7rem 1rem;border-bottom:1px solid var(--line);font-size:12px;color:var(--faint);position:sticky;top:0;background:var(--s1)}
.dots{display:flex;gap:.35rem}.dots i{width:10px;height:10px;border-radius:50%;background:var(--line2)}
.term-cmd{padding:1rem 1.1rem;font-size:13px;color:var(--text)}.prompt{color:var(--accent);margin-right:.6em;user-select:none}
.term .stream{margin:0 1.1rem 1rem}.term .quiet,.term-note{margin:0 1.1rem 1rem;font-size:12.5px;color:var(--faint)}
.stream .label{display:block;margin-bottom:.3rem}.stream pre,.plain,.command{background:var(--stage);border:1px solid var(--line);border-radius:10px;padding:.7rem .85rem;max-height:14rem;overflow:auto;color:var(--text)}
.panel{grid-area:panel;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;background:var(--s1);border-left:1px solid var(--line)}
.panel-scroll{overflow:auto;padding:1.3rem 1.4rem 1.5rem;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
.eyebrow{display:flex;flex-wrap:wrap;gap:.3rem 1rem;margin:0;font-size:12px;color:var(--faint)}.eyebrow>span:first-child{color:var(--accent);font-weight:650}.eyebrow .of{color:var(--faint);font-weight:500}.eyebrow time{font-family:var(--mono)}
.panel h2{font:650 1.2rem/1.35 var(--round);letter-spacing:-.005em;margin:.45rem 0 .5rem;overflow-wrap:anywhere}
.state{margin:0 0 .4rem}
.block{margin-top:1.15rem;padding-top:1.05rem;border-top:1px solid var(--line)}.block h3{margin:0 0 .45rem}.block p{margin:0;color:var(--dim)}
.command{font-size:12px;max-height:9rem}
.receipts{list-style:none;margin:0 0 .4rem;padding:0;display:grid;gap:.45rem}.receipts li{display:flex;flex-wrap:wrap;gap:.4rem .8rem;align-items:center}.diag{font-size:13px;color:var(--dim)}
.exit{display:inline-block;font:650 11.5px var(--mono);padding:.2rem .55rem;border-radius:999px;margin-bottom:.5rem}
.exit.ok{color:var(--ok);background:color-mix(in srgb,var(--ok) 14%,transparent)}.exit.bad{color:var(--bad);background:color-mix(in srgb,var(--bad) 14%,transparent)}
.receipts .exit{margin:0}.stream{margin-bottom:.6rem}
.raw summary{cursor:pointer;font-size:12px;color:var(--faint);width:max-content}.raw summary:hover{color:var(--dim)}.raw pre{margin-top:.5rem;color:var(--faint);font-size:11.5px;max-height:12rem;overflow:auto}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:.8rem 1rem;margin:1.15rem 0 0;padding-top:1.05rem;border-top:1px solid var(--line)}.facts dd{margin:.2rem 0 0;font:12.5px var(--mono);color:var(--dim);overflow-wrap:anywhere}
.facts.stack{grid-template-columns:1fr}
.pager{display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.75rem 1.1rem;border-top:1px solid var(--line);font-size:13px;font-weight:600}
.pager a{padding:.35rem .7rem;border-radius:8px}.pager a:hover{background:var(--s2);text-decoration:none}.pager .stable{font-weight:500;color:var(--faint)}.pager .off{padding:.35rem .7rem;color:var(--line2)}
.files{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}.files li{display:grid}.files a{font:12.5px var(--mono)}.files span{font-size:12px;color:var(--faint)}
.doc{grid-template-rows:minmax(0,1fr);overflow:auto;background:var(--bg)}.doc-in{max-width:52rem;padding:2rem 2.5rem 3rem}
.doc h2{font:650 1.6rem/1.2 var(--round);margin:0}.lede{color:var(--dim);margin:.6rem 0 0}
.findings{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}.findings li{padding:.7rem .9rem;border-radius:10px;background:var(--s1);border:1px solid var(--line);border-left:3px solid var(--warn)}
.findings summary{cursor:pointer}.findings code{display:block;font:11.5px/1.6 var(--mono);color:var(--faint);margin-top:.4rem;overflow-wrap:anywhere}
.outputs{display:grid;gap:.5rem}.group{background:var(--s1);border:1px solid var(--line);border-radius:10px;padding:.65rem .9rem}
.group summary{display:flex;justify-content:space-between;gap:1rem;cursor:pointer;font-size:13px;list-style:none}.group summary::-webkit-details-marker{display:none}
.group .where{font-weight:600}.group .where::before{content:"›";display:inline-block;width:1em;color:var(--faint);transition:rotate .15s}.group[open] .where::before{rotate:90deg}.group .count{color:var(--faint);flex:none}
.group[open] summary{margin-bottom:.7rem}
.flist{list-style:none;margin:0;padding:0;display:grid;gap:.25rem;font:12px var(--mono);max-height:16rem;overflow:auto}.flist li{display:flex;justify-content:space-between;gap:1rem}.flist a{overflow-wrap:anywhere;min-width:0}.flist span{color:var(--faint);flex:none}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:.7rem}.flist+.gallery{margin-top:.75rem}
.gthumb{display:grid;gap:.35rem;font:11.5px var(--mono);min-width:0}.gthumb span{display:flex;justify-content:space-between;gap:.5rem;overflow:hidden}.gthumb small{color:var(--faint);font-size:inherit;flex:none}
.gthumb img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:7px;border:1px solid var(--line);display:block}.gthumb:hover img{border-color:var(--accent)}
.track{border-top:1px solid var(--line);background:var(--s1)}
.track ol{list-style:none;margin:0;padding:.75rem 1.5rem .85rem;display:flex;gap:.65rem;overflow-x:auto;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
.track li{flex:none;width:9.5rem}
.track a{display:grid;gap:.4rem;padding:.3rem;border-radius:11px;border:1px solid transparent;color:var(--text);transition:background .15s,border-color .15s}
.track a:hover{text-decoration:none;background:var(--s2)}
.face{display:block;aspect-ratio:16/9;border-radius:7px;overflow:hidden;background:var(--stage);box-shadow:inset 0 0 0 1px var(--line)}
.face img{width:100%;height:100%;object-fit:cover;display:block}
.face.text pre{padding:.5rem .55rem;font-size:9.5px;line-height:1.45;color:var(--dim);height:100%;overflow:hidden;-webkit-mask-image:linear-gradient(#000 60%,transparent);mask-image:linear-gradient(#000 60%,transparent)}
.cap{display:flex;align-items:center;gap:.4rem;min-width:0;padding:0 .15rem;font-size:12px}
.cap .n{font:650 11px var(--round);color:var(--faint)}.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--tone)}
.cap .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim)}
.track li.bad .face{box-shadow:inset 0 0 0 2px var(--bad)}
@media(max-width:960px){.app{height:auto;min-height:100vh;overflow:visible}.center{grid-template-columns:minmax(0,1fr);grid-template-areas:"stage" "panel"}
.stage{min-height:60vh}.views{padding:.5rem 3.5rem 1rem}.panel{border-left:0;border-top:1px solid var(--line)}.track{position:sticky;bottom:0}.stats{display:none}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media print{.app{height:auto;display:block}.track,.arrow,.seg,.pager,.ovl{display:none}.center{display:block}.step{display:block!important;break-inside:avoid;margin-bottom:1rem}.stage{background:none}.view{display:none!important}.v-compare{display:grid!important;grid-template-columns:1fr 1fr}}`;
