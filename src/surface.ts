import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { RelayManager } from './manager.js';
import { relayParameters, validateRelayInput, type RelayAction } from './schema.js';
import type { ImageResult } from './images.js';

/**
 * The relay's host-agnostic surface: the one tool's name and model-facing
 * text, the action dispatch and the bounded result rendering. Every front
 * end (the MCP server here, pi's extension elsewhere) wraps exactly this,
 * so the model sees the same contract whichever agent runtime hosts it.
 */
export const relayToolName = 'relay';
export const relayPromptSnippet = 'Search installed applications with action=search by name, then select an image. Relay interruptive work: probe → acquire → stage → run → image/extract/finish; failures retain the VM for repair and release explicitly abandons. For user-requested viewing use acquisition-capabilities and console-resolve/console-open/console-cancel. Run and console-open require reason.';
export const relayToolDescription = 'One VM enclosure interface. Required action; run and console-open require intent in reason. '
  + 'search: required application name, optional hard os linux/macos; exact, prefix, substring canonical-name/alias matching. Returns installed versions (possibly null), image keys, OS and architecture; truncated means whole installations were omitted. No allocation, boot, installation, capacity reservation or automatic image choice. Empty success is distinct from catalog errors. '
  + 'probe: default scope=host reports host permissions/activity, VM service availability and owned lifecycle state, not guest readiness. scope=guest checks executables on the owned guest before staging or after repair without installing software; capture/browser readiness remains unverified. Unknown is not idle. '
  + 'acquisition-capabilities: read-only versioned VNC options, no acquisition or ownership recovery. console-resolve: read-only status for the owned lease/environment. console-open: explicit user request only, require userRequested=true, console_id, attempt_id, reason and expected; opens on service-host only, never automatically at acquisition. console-cancel: require console_id and attempt_id; closes managed viewing resources, never releases the VM. Console actions are lifecycle operations without screenshots, not authentication/pixel/human evidence. Resolve uncertain attempts; never automatically replay open. Console status ready is guest preflight, not nested attempt success. macOS requires human Standard sharing of the existing console, not a new Log In session or High Performance display. Never auto-confirm selection; server_enforced_view_only=false and viewer-selection-unverified remain limitations even after transport connects. '
  + 'acquire: one fresh VM for this prompt-composed subagent, register ownership and heartbeat; require task, image and extractions (declare outputs up front, [] allowed); optional ttlHours/env/fullWorkspace/vnc (boolean, default false; prepares sharing without opening). '
  + 'stage: hash-check runtime and optional workspace/files/nodePath/cuaDriver/browser. Corrected setup can be retried after errors; a staged runtime accepts corrected executable paths. resetRecording=true explicitly archives existing recording evidence and starts a fresh recording on the same VM, refusing an existing receiver lock. Staging success does not prove capture readiness. Guest Node and driver must exist; support goes under support/. Linux needs native X11 and cua-driver serve --no-overlay. browser:{} enables fresh persistent guest Playwright; no download or CDP attachment. After every browser event the page is settle-waited (load, network idle, fonts, two frames; settleTimeoutMs, default 5000) and an event that changed the address gets a landing page capture; captures and their records land in workspace/browser-captures, declared as an extraction automatically. '
  + 'run: ONE admitted operation, require reason/kind/step/snapshots. exec needs argv; script needs localPath/language; code needs code/language; cua needs tool and optional args; browser needs one browser event: navigate, click, type, press, read, or snapshot (capture the settled page now, optional name). Do not hide multiple UI interactions in a script-level pair. Ordinary UI means real pointer/keyboard, not direct accessibility. Explicit afterIntervalMs required per event or on text group last, no defaults/stability detection. Choose semantics-appropriate waits, e.g. 100ms text, 500ms dialog, 16ms game, not prescribed values. Text groups are sender-declared consecutive first/member/last events. Failures retain the VM and allow agent-directed repair; never automatically replay uncertain input. timeoutMs defaults to 120000 and accepts integers 1..3600000 independently of snapshot delay. exec diagnostic=true explicitly records command diagnosis/repair without screenshot evidence, including before staging; do not claim visual verification. A run result carries the execution identity and outcome, the guest\'s bounded stdout/stderr, for a browser event the parsed browser answer (settled facts, landing or snapshot capture, read text), and the saved after-image as a typed image block when that phase was captured and delivered. '
  + 'image: retrieve one saved image without input, capture, directory export, or acquisition. target selects display (sessionId/executionId/phase), application (declared name and relative path for a directory), or reference (imageId). PNG/JPEG/WebP only; originals max64MiB, decoded max40M pixels; preview max2000x2000 and 4MiB base64 (PNG originals are resampled in-process; JPEG/WebP pass through only within bounds). Each image delivery has a 90s deadline and at most three eligible file-transfer attempts; recommend no more than two explicit reference recovery calls. Closed enclosures return stale-reference; delivered originals remain readable by host read. Attachment does not prove provider acceptance or inspection. '
  + 'extract: require names, pull only declared outputs, verify hashes and reject traversal/symlinks/changing sources. '
  + 'finish: extract declared outputs, deliver/verify a portable snapshot package then destroy/unregister; delivery, snapshots, execution and human review are separate. '
  + 'release: abandon, retain available evidence and destroy the owned VM without claiming success; safe to retry failed cleanup. '
  + 'Use finish or release explicitly when done. Session shutdown and agent completion pause renewal without destroying the VM; backend expiration handles abandoned leases. Inspect current owned state through probe after context compaction. Only selected-action fields are permitted; no default action. No physical/local UI targets, video API or spawn API. Text output is capped at 50 KiB / 2000 lines; larger responses are retained in a local file.';

const labels: Record<RelayAction, string> = { 'acquisition-capabilities': 'Acquisition capabilities', 'console-resolve': 'Resolve console', 'console-open': 'Open console', 'console-cancel': 'Cancel console', search: 'Search', probe: 'Probe', acquire: 'Acquire', stage: 'Stage', run: 'Run', image: 'Image', extract: 'Extract', finish: 'Finish', release: 'Release' };
export function actionLabel(action: unknown): string {
  return `Relay · ${typeof action === 'string' && Object.hasOwn(labels, action) ? labels[action as RelayAction] : 'Pending action'}`;
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
