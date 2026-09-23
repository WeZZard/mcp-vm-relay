import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { RelayManager } from './manager.js';
import { relayParameters, toolInputSchema, validateRelayInput, type RelayAction, type RunKind } from './schema.js';
import type { ImageResult } from './images.js';

/**
 * The relay's host-agnostic surface: the nineteen tools' identity and
 * model-facing text, the action dispatch and the bounded result rendering.
 * The MCP server (`src/server.ts`) wraps exactly this, so every MCP client
 * (Claude Code, pi through pi-mcp-adapter, or a bare MCP client) sees the
 * same nineteen tools with the same schemas, results and error semantics.
 */
export interface RelayToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
export interface RelayTool { name: string; title: string; description: string; annotations: RelayToolAnnotations; action: RelayAction; kind?: RunKind }

/** Read-only tools: they never change the VM, and calling one again changes nothing new. */
const readOnly: RelayToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** A tool that acts on the VM. `destructive` is true only for the two tools that destroy it; `openWorld` is true only for the tools that run guest code, which may reach the network. */
const acts = (openWorld: boolean, destructive = false): RelayToolAnnotations => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: false, openWorldHint: openWorld });

const runShared = 'Shares relay_exec\'s `reason`, `step`, `snapshots` and `timeoutMs` fields: one admitted operation per call, an explicit `snapshots.afterIntervalMs` chosen for this event (no default), and a result carrying the execution identity and outcome plus the saved after-image inline when the plan captured it. A refused, uncertain or nonzero result keeps the VM; never replay input whose effect is uncertain.';

export const relayTools: readonly RelayTool[] = [
  {
    name: 'relay_search', action: 'search', title: 'Search installed applications', annotations: readOnly,
    description: 'Find an installed application in the image inventories by name, then choose an image yourself; optional before relay_acquire. Matches canonical names and aliases by exact, prefix and substring comparison, with an optional hard `os` filter (`linux`/`macos`). Returns each match\'s installed versions (which may be null), image keys, OS and architecture; a truncated result means whole installations were omitted, and an empty result is distinct from a catalog error. Never allocates, boots, installs, reserves capacity or chooses an image for you.',
  },
  {
    name: 'relay_probe', action: 'probe', title: 'Probe host and guest readiness', annotations: readOnly,
    description: 'Read-only host and service facts, used to judge whether a task is interruptive and to pick an image; it reports current owned state on its own, so call it again after context compaction rather than trusting earlier messages. Default `scope: "host"` reports host permissions and activity, VM service availability, and this session\'s owned lifecycle state, not guest readiness; unknown is not idle. `scope: "guest"` (on an already-owned VM) checks only that Node and the CuaDriver executable exist on the guest, before staging or after a repair, without installing anything, and never claims capture or browser readiness. Relay only interruptive work judged from these facts; non-disruptive or headless work stays with local tools. Continue in order: relay_acquire, relay_stage, a run tool, relay_image/relay_extract, then relay_finish or relay_release, called explicitly before you return.',
  },
  {
    name: 'relay_acquisition_capabilities', action: 'acquisition-capabilities', title: 'Read acquisition capabilities', annotations: readOnly,
    description: 'Read the backend\'s versioned VNC console options for the images it serves. Read-only: it neither acquires a VM nor recovers ownership of one.',
  },
  {
    name: 'relay_acquire', action: 'acquire', title: 'Acquire a VM', annotations: acts(false),
    description: 'Acquire one fresh VM for this task and start its ownership heartbeat. Requires `task` (a short slug), `image` (a key from relay_probe or relay_search) and `extractions`: every output you intend to bring home, declared before any work (`[]` is allowed; nothing is extracted automatically). Optional `ttlHours` (default 4), `env` (a credential pack, never baked into images), `fullWorkspace` (opt in to deliver the whole workspace) and `vnc` (default false; only prepares console-sharing capacity, never opens a viewer). One task per enclosure: call this once per task, not again for another task. Continue with relay_stage, a run tool, relay_image/relay_extract, then relay_finish or relay_release explicitly before you return; a failed step keeps the VM for repair rather than replaying uncertain input.',
  },
  {
    name: 'relay_stage', action: 'stage', title: 'Stage the guest runtime', annotations: acts(false),
    description: 'Push and hash-check the guest runtime, plus an optional workspace, support files and browser, onto an already-acquired VM. A failed stage can be retried with corrected paths; once staged, only corrected executable paths (`nodePath`, `cuaDriver`) may be resubmitted, and staging success does not prove capture readiness. The guest Node and CuaDriver executables must already exist; `files` land under `support/`. Linux guests need native X11 and `cua-driver serve --no-overlay`. `browser: {}` enables a fresh persistent guest Playwright page (default settle timeout 5000 ms, `settleTimeoutMs` up to 60000; `playwrightModule` overrides the guest module path), never downloads a browser or attaches over CDP, and declares the extraction `browser-captures` automatically. `resetRecording: true` explicitly archives the current recording\'s evidence and starts a fresh recording on the same VM, keeping prior evidence available; it refuses while an existing receiver lock is held. Use it after diagnosing damaged recording state, then stage again.',
  },
  {
    name: 'relay_exec', action: 'run', kind: 'exec', title: 'Run a guest command', annotations: acts(true),
    description: 'Run one admitted guest command as a single recorded operation; never hide several interactions in one call. Requires `reason` (intent, retained as evidence, never authorization), `step` (`id`, `title`, `expected` result, `inputMode`: `ordinary` for real pointer/keyboard input or `accessibility` for direct accessibility APIs), `snapshots` (an explicit `afterIntervalMs` chosen for this event\'s semantics, e.g. ~100 ms for a text echo, ~500 ms for a dialog, ~16 ms for a game frame; there is no default or stability detection) and `argv`. Consecutive keystrokes may be declared as an explicit text group with `snapshots.group` (`first`/`member`/`last`); the group\'s `last` member needs its own `afterIntervalMs`. Optional `timeoutMs` bounds only command execution (default 120000, up to 3600000), independent of the snapshot delay. A refused, uncertain or nonzero result keeps the VM for a repair operation; never replay input whose effect is uncertain. The result carries the execution identity and outcome, the guest\'s bounded stdout/stderr, and, when the snapshot plan captured the after phase, the saved after-image as an inline image block; inspect it before choosing the next step. Set `diagnostic: true` to record a command\'s diagnosis or repair without screenshot evidence, including before relay_stage; it cannot join a snapshot group and is never visual verification.',
  },
  {
    name: 'relay_script', action: 'run', kind: 'script', title: 'Run a guest script', annotations: acts(true),
    description: `Run one guest script file as this call's single recorded operation. ${runShared} Requires \`localPath\` (a host file path) and \`language\` (\`javascript\`, \`typescript\` or \`python\`); it runs under the staged workspace.`,
  },
  {
    name: 'relay_code', action: 'run', kind: 'code', title: 'Run guest code', annotations: acts(true),
    description: `Run inline guest code as this call's single recorded operation. ${runShared} Requires \`code\` (up to 1 MiB) and \`language\` (\`javascript\`, \`typescript\` or \`python\`).`,
  },
  {
    name: 'relay_cua', action: 'run', kind: 'cua', title: 'Run a CUA driver call', annotations: acts(true),
    description: `Run one CUA driver call as this call's single recorded operation. ${runShared} Requires \`tool\` and optional \`args\`. A direct-accessibility form (\`set_value\`; \`type_text\` on macOS; or \`click\`/\`double_click\`/\`right_click\`/\`press_key\` with \`args.element_index\`) requires \`step.inputMode: "accessibility"\`; otherwise use ordinary pointer/keyboard tools for real input.`,
  },
  {
    name: 'relay_browser', action: 'run', kind: 'browser', title: 'Send a browser event', annotations: acts(true),
    description: `Send one browser event (\`navigate\`, \`click\`, \`type\`, \`press\`, \`read\` or \`snapshot\`) as this call's single recorded operation, to the persistent guest Playwright page relay_stage enabled. ${runShared} After every input event the guest waits for the page to settle (load, network idle, fonts, two frames), bounded by relay_stage's \`settleTimeoutMs\` (default 5000 ms) and by this call's own deadline; the settle facts return as \`settled\`. An event that changed the address gets a landing capture of where it arrived; \`snapshot\` captures the current settled page on demand with an optional \`name\`. Captures and their console-line records land in \`workspace/browser-captures\` and come home with relay_finish. An event that misses its deadline has its browser context closed; the next event opens a fresh page, and nothing already dispatched is replayed.`,
  },
  {
    name: 'relay_image', action: 'image', title: 'Retrieve a saved image', annotations: readOnly,
    description: 'Retrieve one already-saved image; never a new capture, input or directory export, and it never acquires a VM. `target` selects a display phase (`sessionId`/`executionId`/`phase`: `before`/`after`), a declared application file (`name`, plus a relative `path` for a directory declaration), or an immutable `reference` (`imageId`). PNG, JPEG and WebP only; originals up to 64 MiB and 40,000,000 decoded pixels; the delivered preview is at most 2000x2000 px and 4 MiB of base64 (PNG originals are resampled in-process; JPEG/WebP pass through only within bounds). Each delivery has a 90-second deadline and up to three transfer attempts. If a run\'s inline image did not arrive, recover it here with the same `imageId` or display selector, never by repeating the input or capturing again, and stop after at most two such recovery calls if it still cannot be inspected. A closed enclosure returns `stale-reference` for a display or reference target; its delivered originals stay readable with host file tools. An attached image proves only that the block was included, not that anyone inspected or reviewed it.',
  },
  {
    name: 'relay_extract', action: 'extract', title: 'Extract declared outputs', annotations: acts(false),
    description: 'Pull one or more already-declared extraction outputs home early, by `names`. Only outputs declared on relay_acquire may be pulled; each pull verifies source and host hashes and rejects path traversal, symlinks, or a source that changed underneath it.',
  },
  {
    name: 'relay_finish', action: 'finish', title: 'Finish and deliver evidence', annotations: acts(false, true),
    description: 'Complete the task: extract every declared output, deliver and verify a portable evidence package, then destroy the VM and unregister it. The result reports delivery, snapshot completeness, execution outcome and human review as separate facts; a verified package is not a passing test, and a delivered package is not itself human approval. Call this, or relay_release, explicitly before you return, since ending the session does not do it for you. A failed delivery keeps the VM for a corrected attempt.',
  },
  {
    name: 'relay_release', action: 'release', title: 'Release the VM', annotations: acts(false, true),
    description: 'Abandon the task: destroy the owned VM and unregister it, retaining whatever evidence already exists, without claiming the task succeeded. Use this instead of relay_finish when the task is not being completed. Safe to retry if a previous release attempt failed; a failed release keeps ownership until destruction is verified.',
  },
  {
    name: 'relay_console_resolve', action: 'console-resolve', title: 'Resolve console status', annotations: readOnly,
    description: 'Refresh this session\'s non-secret console-viewing status for the owned lease. Read-only, and it never recovers ownership. A `ready` status means guest preflight only, not that a viewer launched: console operations carry no screenshots and never establish authentication, displayed pixels or a human\'s confirmation. On macOS, viewing requires the human to choose Standard sharing of the existing console, not a new Log In session or a High Performance display, and the relay never auto-confirms that choice; `server_enforced_view_only: false` and an unverified viewer selection remain limitations even once transport connects. Never replay an uncertain attempt: resolve it here, or close it with relay_console_cancel.',
  },
  {
    name: 'relay_console_open', action: 'console-open', title: 'Open console viewing', annotations: acts(false),
    description: 'Open console viewing for the owned lease, only following an explicit user request to watch. Requires `console_id` and `attempt_id` from relay_console_resolve, `userRequested: true`, `reason` (intent) and `expected` (what the human should expect to see); it opens on the declared service host, never a remote client, and is never triggered automatically by relay_acquire\'s `vnc` option. See relay_console_resolve for what a `ready` status does and does not prove. A failed or uncertain open keeps the attempt: resolve or cancel it rather than opening again with a new attempt.',
  },
  {
    name: 'relay_console_cancel', action: 'console-cancel', title: 'Cancel console viewing', annotations: acts(false),
    description: 'Cancel an open or uncertain console-viewing attempt by `console_id` and `attempt_id`. Closes managed viewing resources only; it never releases or destroys the VM.',
  },
];

/** A tool's own input schema, derived fresh from the strict contract branch its `action`/`kind` selects. */
export function relayToolInputSchema(tool: RelayTool): Record<string, unknown> {
  return toolInputSchema(tool.action, tool.kind);
}

/** Map one MCP call's tool name and arguments back to the strict contract's action shape, e.g. `relay_exec` args become `{ action: 'run', kind: 'exec', ...args }`, then dispatched through `relayCall` exactly as the retired single `relay` tool was. */
export function relayToolInput(name: string, args: Record<string, unknown>): unknown {
  const tool = relayTools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Unknown relay tool: ${name}`);
  return { action: tool.action, ...(tool.kind ? { kind: tool.kind } : {}), ...args };
}

/** The tool's input schema as plain JSON (TypeBox symbol keys dropped), for front ends that hand JSON Schema to a runtime. */
export function relayJsonSchema(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(relayParameters)) as Record<string, unknown>;
}

export interface RelayRendered { text: string; details: unknown; resultPath?: string }
/** A typed image block for the runtime's tool result: base64 bytes without a data-URL prefix. */
export interface RelayImageContent { type: 'image'; data: string; mimeType: string }
export interface RelayCallResult extends RelayRendered {
  isError: boolean;
  /** For an image-bearing result: the delivery outcome and identity, kept beside the text so truncation never hides them. */
  imageDelivery?: Omit<ImageResult, 'content'>;
  /** The delivered image, when the delivery attached one. */
  image?: RelayImageContent;
}
/** The details kind of an image-bearing result; a front end may use it to tell such results apart. */
export const relayResultKind = 'relay-image-result-v1';

/** Text output is capped at 50 KiB / 2000 lines; a larger result is retained whole in a private local file. */
export async function renderRelayResult(value: unknown, resultRoot = join(tmpdir(), 'mcp-vm-relay-results')): Promise<RelayRendered> {
  const full = JSON.stringify(value, null, 2);
  const text = new TextDecoder().decode(Buffer.from(full.split('\n').slice(0, 2000).join('\n')).subarray(0, 50 * 1024), { stream: true });
  if (text !== full) {
    await mkdir(resultRoot, { recursive: true, mode: 0o700 });
    const path = join(resultRoot, `${randomUUID()}.json`); await writeFile(path, full, { mode: 0o600 });
    return { text: `${text}\n[Truncated. Full result: ${path}]`, details: { resultPath: path }, resultPath: path };
  }
  return { text, details: value };
}

/**
 * An image-bearing result: the delivery identity leads the text (so it stays
 * model-visible even when command output exceeds the text bound), the rendered
 * result follows, and the image rides as its own block. Execution failure and
 * delivery failure both make the result an error without discarding the image.
 */
async function imageResult(value: Record<string, unknown>, delivery: ImageResult, executionFailed = false): Promise<RelayCallResult> {
  const { content: image, ...imageDelivery } = delivery;
  const { imageDelivery: _, ...rest } = value;
  const rendered = await renderRelayResult(rest);
  const failed = executionFailed || !['attached', 'not-requested'].includes(delivery.status);
  return {
    text: `${JSON.stringify({ imageDelivery, executionFailed })}\n${rendered.text}`,
    details: { kind: relayResultKind, isError: failed, result: rendered.details, imageDelivery },
    ...(rendered.resultPath ? { resultPath: rendered.resultPath } : {}),
    isError: failed, imageDelivery, ...(image ? { image } : {}),
  };
}

/**
 * One relay call: validate the raw input against the strict contract (even
 * when the runtime validated already), dispatch to the manager, render the
 * result. A run whose execution was refused, uncertain or exited nonzero is
 * an error result, as is a run or image whose delivery failed; the front end
 * decides how its runtime signals that. The manager may be given as a getter
 * so that an invalid call creates nothing.
 */
export async function relayCall(host: RelayManager | (() => RelayManager), raw: unknown, options: { signal?: AbortSignal; toolCallId?: string } = {}): Promise<RelayCallResult> {
  validateRelayInput(raw); // Invalid input never obtains a manager: a getter is only called past this point.
  const manager = typeof host === 'function' ? host() : host;
  const { signal, toolCallId } = options;
  let value: unknown;
  switch (raw.action) {
    case 'acquisition-capabilities': value = await manager.acquisitionCapabilities(signal); break;
    case 'console-resolve': value = await manager.consoleResolve(signal); break;
    case 'console-open': value = await manager.consoleOpen(raw, signal); break;
    case 'console-cancel': value = await manager.consoleCancel(raw, signal); break;
    case 'search': value = await manager.search({ name: raw.name, os: raw.os }, signal, toolCallId); break;
    case 'probe': value = await manager.probe(raw.scope); break;
    case 'acquire': {
      const { action: _, ...input } = raw;
      value = await manager.acquire(input, signal); break;
    }
    case 'stage': {
      const { action: _, ...input } = raw;
      value = await manager.stage(input, signal); break;
    }
    case 'run': {
      const { action: _, reason: because, ...input } = raw;
      const execution = await manager.run({ ...input, because }, signal);
      const failed = execution.outcome.kind !== 'completed' || execution.outcome.exitStatus.code !== 0 || !!execution.outcome.exitStatus.signal;
      if ('imageDelivery' in execution) return imageResult(execution, execution.imageDelivery, failed);
      const rendered = await renderRelayResult(execution);
      return { ...rendered, isError: failed };
    }
    case 'image': return imageResult({}, await manager.image(raw.target, signal));
    case 'extract': value = await manager.extract(raw.names, signal); break;
    case 'finish': value = await manager.finish(signal); break;
    case 'release': value = await manager.release(); break;
  }
  return { ...(await renderRelayResult(value)), isError: false };
}
