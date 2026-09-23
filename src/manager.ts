import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, cp, access, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { relayStateRoot } from './config.js';
import { fileURLToPath } from 'node:url';
import { Relay, type Session, type SnapshotsRequest, type StepDescription } from '@wezzard/relay-driver-host-sdk';
import { VmService, VmServiceError, type VmLease, type VmBackend } from './vm-service.js';
import { canonicalPath, environmentVariables, matchesEnvironment, selectedEnvironment, type SelectedEnvironment } from './environment.js';
import { homedir } from 'node:os';
import { Registry, type RegistryRow } from './registry.js';
import { Transfer, assertHostPath, type VmChannel } from './transfer.js';
import { VmTransport } from './transport.js';
import { command, hash, jsonFile, within } from './util.js';
import { deliverPackage, type DeliveryResult } from './package.js';
import { probeLocal } from './probe.js';
import { acquireOwnerLock, type OwnerLock } from './owner-lock.js';
import { searchCatalog, type SearchQuery } from './search.js';
import { recordSearch } from './search-diagnostics.js';
import { acquisitionCapabilities, consoleStatus, type ConsoleStatus } from './console.js';
import { ImageStore, imageCapability, type ImageTarget, type ImageResult } from './images.js';
import { refreshEvidenceState } from './evidence-merge.js';

export interface Extraction { path: string; name: string }
export interface AcquireInput { task: string; image: string; extractions: Extraction[]; ttlHours?: number; fullWorkspace?: boolean; env?: string; vnc?: boolean }
export interface ConsoleAttemptInput { console_id: string; attempt_id: string }
export interface ConsoleOpenInput extends ConsoleAttemptInput { userRequested: true; reason: string; expected: string }
export interface StageInput { resetRecording?: boolean; workspace?: string; files?: Array<{ local: string; path: string }>; nodePath?: string; cuaDriver?: string; browser?: { playwrightModule?: string; settleTimeoutMs?: number } }
export interface RunInput { because: string; timeoutMs?: number; diagnostic?: boolean; kind: 'exec' | 'script' | 'code' | 'cua' | 'browser'; step: StepDescription; snapshots: SnapshotsRequest; argv?: string[]; localPath?: string; language?: 'javascript' | 'typescript' | 'python'; code?: string; tool?: string; args?: Record<string, unknown>; browser?: { action: 'navigate' | 'click' | 'type' | 'press' | 'read' | 'snapshot'; url?: string; selector?: string; text?: string; key?: string; name?: string } }
interface BackendBinding { endpoint: string; tartHome: string; environmentFingerprint?: string }
interface Enclosure {
  backend?: BackendBinding;
  purpose: string; task: string; image: string; project: string; startedAt: string;
  guestRoot: string; hostRoot: string; ttlHours: number; extractions: Extraction[]; fullWorkspace: boolean;
  lease?: VmLease; row: RegistryRow; staged: boolean; node?: string; cuaDriver?: string; sessionId?: string;
  failed?: string; lastError?: string; released?: boolean; delivered?: DeliveryResult; acquisitionInFlight?: boolean; browser?: boolean;
  active?: boolean; guestState?: string; expiresAt?: number; browserConfig?: StageInput['browser'];
  previousEvidence?: Array<{ path: string; sessionId: string; guestState?: string }>;
  pendingReset?: { id: string; from: string; fromSession: string; to: string };
  consoleObservation?: ConsoleStatus;
  consoleAttempt?: { console_id: string; attempt_id: string; status: string };
  consoleAttemptIds?: string[];
}
export interface ManagerOptions { sessionId: string; project: string; stateRoot?: string; outputRoot?: string; registry?: Registry; vm?: VmBackend; environment?: SelectedEnvironment; tartHome?: string; tartPath?: string; runtimeBundle?: string; heartbeatMs?: number; verifyDestroyed?: (vm: string) => Promise<boolean> }
/** The workspace directory and extraction name that carry the guest browser's page captures home. */
export const BROWSER_CAPTURES = 'browser-captures';
/**
 * The server's MCP `instructions`: the rules that cut across all nineteen
 * tools rather than belonging to one of them (see each tool's own
 * description for its specific contract). A compact version of the same
 * rules also lives in the `relay_probe` and `relay_acquire` descriptions,
 * because not every MCP client surfaces server instructions to the model.
 */
export const instructions = 'This server offers nineteen tools for one interruptive VM enclosure: relay_search, relay_probe, relay_acquisition_capabilities, relay_acquire, relay_stage, the run tools relay_exec/relay_script/relay_code/relay_cua/relay_browser, relay_image, relay_extract, relay_finish, relay_release, relay_console_resolve, relay_console_open, relay_console_cancel, relay_status and relay_trajectory. Relay only interruptive computer-use or browser-use that would otherwise take over a real desktop or browser, judged for yourself from relay_probe facts; unknown is not idle, and non-disruptive or headless work stays with local tools. One task gets one enclosure: call relay_acquire once per task, never reused for a second task. Work an enclosure in order: relay_probe, then relay_acquire, then relay_stage, then one or more run tools, then relay_image or relay_extract as needed, then relay_finish or relay_release. Always call relay_finish or relay_release explicitly before you return an answer; ending the session only pauses lease renewal, it does not destroy the VM, and the backend\'s own expiry is the last-resort safeguard. A refused, uncertain or nonzero operation keeps the VM so you can diagnose and submit a corrected operation; never replay input whose effect is uncertain. A tool result, an attached image or a verified evidence package, is evidence for a human reviewer, never the review itself. The relay never targets a physical or local display and offers no video or spawn API. Every tool\'s text result is capped at 50 KiB / 2000 lines; a larger result is retained whole in a local file the result names.';

export class RelayManager {
  readonly vm: VmBackend;
  readonly environment?: SelectedEnvironment;
  readonly tartHome: string;
  readonly tartPath: string;
  readonly registry: Registry;
  readonly root: string;
  readonly channel: VmChannel;
  private enclosure?: Enclosure;
  private session?: Session;
  private transport?: VmTransport;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeating = false;
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private ownerLock?: OwnerLock;
  private shuttingDown = false;
  constructor(readonly options: ManagerOptions) {
    this.environment = options.environment ?? selectedEnvironment();
    this.tartHome = this.environment?.profile.tartHome ?? canonicalPath(options.tartHome ?? process.env.TART_HOME ?? join(process.env.HOME ?? homedir(), '.tart'));
    this.tartPath = this.environment?.profile.tartPath ?? options.tartPath ?? process.env.TART ?? 'tart';
    if (this.environment && ((options.stateRoot && canonicalPath(options.stateRoot) !== this.environment.profile.relayStateDir) || (options.tartHome && canonicalPath(options.tartHome) !== this.tartHome) || (options.tartPath && canonicalPath(options.tartPath) !== this.tartPath))) throw new Error('Injected paths conflict with the selected environment');
    this.vm = options.vm ?? new VmService({ baseUrl: this.environment?.profile.vmServiceUrl ?? process.env.MCP_VM_RELAY_URL, environment: this.environment });
    this.registry = options.registry ?? new Registry(this.environment ? { managedRoot: this.environment.profile.relayStateDir } : {});
    this.root = join(this.environment?.profile.relayStateDir ?? options.stateRoot ?? relayStateRoot(), hash(options.sessionId).slice(0, 32));
    this.channel = {
      exec: async (name, argv, timeoutMs = 180000, options) => {
        const result = await this.vm.exec(name, { argv, timeout: Math.ceil(timeoutMs / 1000) }, { timeoutMs: options?.timeoutMs ?? timeoutMs + 30000, signal: options?.signal });
        return { stdout: result.output, stderr: result.output, code: result.rc };
      },
      push: (name, local_path, remote_path) => this.vm.push(name, { local_path, remote_path }),
      pull: (name, remote_path, local_path, options) => this.vm.pull(name, { remote_path, local_path }, options),
    };
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.catch(() => {}); return next;
  }
  async initialize() { return this.serialized(() => this.init()); }
  private async init(hostOnly = false) {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!this.ownerLock) {
      this.ownerLock = await acquireOwnerLock(join(this.root, 'owner.lock')); // Stable inode; never unlink.
      try { this.enclosure = JSON.parse(await readFile(join(this.root, 'lease.json'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { await this.unlock(); throw e; } }
    }
    try {
      if (this.enclosure) {
        this.enclosure.active = false;
        if (hostOnly) return;
        await this.reconcile();
        if (this.enclosure?.staged && !this.enclosure.delivered) {
          try { await this.attach(); }
          catch (error) { await this.fail(new Error(`Recording session restoration failed; diagnostic repair remains available: ${String(error)}`)); }
        }
      }
      this.initialized = true;
    } catch (error) { await this.unlock(); throw error; }
  }
  private binding(): BackendBinding { return { endpoint: this.vm.baseUrl, tartHome: this.tartHome, ...(this.environment ? { environmentFingerprint: this.environment.identity.fingerprint } : {}) }; }
  private bindingMatches(e: Enclosure): boolean {
    if (e.backend) {
      const expected = this.binding();
      return Object.keys(e.backend).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => e.backend![key as keyof BackendBinding] === value);
    }
    // Only the original default deployment may adopt pre-binding legacy state.
    return !this.environment && new URL(this.vm.baseUrl).origin === 'http://localhost:6240' && this.tartHome === canonicalPath(join(process.env.HOME ?? homedir(), '.tart'));
  }
  private assertBinding() {
    if (this.enclosure && !this.bindingMatches(this.enclosure)) throw new Error('Owned lease belongs to a different or unknown VM environment; select its original environment before operating on it');
  }
  private async assertBackend() {
    if (!this.environment) return;
    if (new URL(this.vm.baseUrl).origin !== new URL(this.environment.profile.vmServiceUrl).origin) throw new Error('Injected backend endpoint does not match selected environment');
    const health = await this.vm.health({ timeoutMs: 5000 });
    if (!health.ok || !matchesEnvironment(health.environment, this.environment)) throw new Error('VM service environment identity mismatch; no lease operation was performed');
  }
  private async save() { await jsonFile(join(this.root, 'lease.json'), this.enclosure ?? null); }
  private async unlock() { if (this.ownerLock) { await this.ownerLock.release(); this.ownerLock = undefined; } }
  status() { const e = this.enclosure; return e ? { task: e.task, backend: e.backend, vm: e.lease?.vm, lease_id: e.lease?.lease_id, console: e.consoleObservation, consoleAttempt: e.consoleAttempt, purpose: e.purpose, staged: e.staged, lastError: e.lastError ?? e.failed, released: e.released, active: e.active ?? false, guestState: e.guestState ?? 'unknown', previousEvidence: e.previousEvidence, recordingResetPending: !!e.pendingReset, expiresAt: e.expiresAt ?? e.lease?.ttl_expires_at, output: e.hostRoot } : { active: false }; }
  private async reconcile() {
    const e = this.enclosure; if (!e) return;
    this.assertBinding(); await this.assertBackend();
    e.backend ??= this.binding();
    if (!e.lease) {
      const matches = Object.values((await this.vm.list({ timeoutMs: 10000 })).vms).filter(v => v.purpose === e.purpose);
      if (matches.length !== 1) throw new Error(`Cannot reconcile acquisition for ${e.purpose}; ownership retained, never automatically reacquire`);
      e.lease = matches[0]; e.acquisitionInFlight = false;
    }
    try {
      const lease = await this.vm.get(e.lease.vm, { timeoutMs: 10000 });
      if (lease.purpose !== e.purpose || (e.lease.lease_id && lease.lease_id !== e.lease.lease_id)) throw new Error('Lease ownership identity mismatch');
      if (e.lease.console?.console_id && lease.console?.console_id !== e.lease.console.console_id) throw new Error('Console instance identity mismatch during lease reconciliation');
      if (lease.console) {
        lease.console = consoleStatus(lease.console);
        if (lease.console.status === 'revoked') e.consoleObservation = lease.console;
      }
      e.lease = lease; e.guestState = lease.state; e.expiresAt = lease.ttl_expires_at;
      if (e.failed) { e.lastError = e.failed; delete e.failed; }
      await this.save();
    } catch (error) {
      e.guestState = 'unknown';
      if (error instanceof VmServiceError && error.status === 404 && await this.destroyed(e.lease.vm)) {
        await this.registry.remove(e.row);
        await jsonFile(`${e.hostRoot}.lifecycle.json`, { purpose: e.purpose, vm: e.lease.vm, released: true, reason: 'backend lease absent and destruction verified', finishedAt: new Date().toISOString() });
        this.enclosure = undefined; await this.save(); return;
      }
      await this.save(); throw error;
    }
  }
  private async attach() {
    const e = this.current();
    if (!e.sessionId || !e.node) throw new Error('Persisted staged session lacks runtime identity');
    const relay = Relay.open(join(e.hostRoot, 'host', 'submissions'));
    this.transport = new VmTransport(this.transfer(), e.guestRoot, join(e.hostRoot, 'host'), e.cuaDriver!);
    this.session = await relay.attach(e.sessionId, this.transport);
  }
  search(query: SearchQuery, signal?: AbortSignal, toolCallId?: string) { return this.serialized(async () => {
    // Deliberately bypass init/recovery, ownership locks, probes and lease APIs.
    let result;
    try {
      signal?.throwIfAborted();
      result = searchCatalog(await this.vm.applications({ signal }), query);
    } catch (error) {
      await recordSearch(this.root, query, { error }, { toolCallId });
      throw error;
    }
    await recordSearch(this.root, query, { result }, { toolCallId });
    return result;
  }); }
  probe(scope: 'host' | 'guest' = 'host') { return this.serialized(async () => {
    if (scope === 'guest') {
      await this.init();
      return this.guarded(undefined, async () => {
        const e = this.current();
        const checks = [];
        for (const [name, argv] of [['node', [e.node ?? 'node', '--version']], ['cuaDriver', [e.cuaDriver ?? (e.lease!.image_kind === 'macos' ? '/Applications/CuaDriver.app/Contents/MacOS/cua-driver' : 'cua-driver'), '--version']]] as const) {
          try { const r = await this.channel.exec(e.lease!.vm, [...argv], 10000); checks.push({ name, ...r, ready: r.code === 0 }); }
          catch (error) { checks.push({ name, ready: false, diagnostic: String(error) }); }
        }
        const facts = { scope, observedAt: new Date().toISOString(), owned: this.status(), checks, captureVerified: false, browserVerified: false };
        await this.log('guest-readiness', undefined, facts); return facts;
      });
    }
    const local = await probeLocal();
    let relay;
    try { const [health, images, leases] = await Promise.all([this.vm.health({ timeoutMs: 5000 }), this.vm.images({ timeoutMs: 5000 }), this.vm.list({ timeoutMs: 5000 })]); relay = { reachable: health.ok, images, capacity: leases.limits }; }
    catch (error) { relay = { reachable: false, diagnostic: String(error) }; }
    const facts = { scope: 'host', local, relay, environment: this.environment?.identity, owned: this.status(), capabilities: { image: imageCapability } };
    await jsonFile(join(this.root, 'probes', `${Date.now()}-${randomUUID()}.json`), facts);
    await this.log('probe', undefined, facts);
    return facts;
  }); }
  private async readAcquisitionCapabilities(signal?: AbortSignal) {
    signal?.throwIfAborted(); await this.assertBackend();
    if (!this.vm.acquisitionCapabilities) throw new Error('Backend lacks acquisition-capabilities; upgrade vm-service for VNC');
    return acquisitionCapabilities(await this.vm.acquisitionCapabilities({ signal, timeoutMs: 10000 }));
  }
  acquisitionCapabilities(signal?: AbortSignal) { return this.serialized(() => this.readAcquisitionCapabilities(signal)); }
  private async consoleOwner(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.shuttingDown) throw new Error('Relay manager is shutting down');
    await this.init(); await this.reconcile();
    const e = this.current();
    if (!e.lease!.lease_id) throw new Error('Legacy lease lacks console identity; no automatic retrofit is available');
    return e;
  }
  private async resolveConsole(signal?: AbortSignal) {
    const e = await this.consoleOwner(signal);
    if (!this.vm.consoleResolve) throw new Error('Backend lacks console API; upgrade vm-service');
    let observation: ConsoleStatus;
    try { observation = consoleStatus(await this.vm.consoleResolve(e.lease!.vm, { lease_id: e.lease!.lease_id! }, { signal, timeoutMs: 10000 })); }
    catch (error) {
      if (e.consoleObservation && e.consoleObservation.status !== 'revoked') e.consoleObservation = { ...e.consoleObservation, status: 'unknown' };
      await this.save(); throw error;
    }
    this.assertConsoleIdentity(observation, e);
    if (e.lease!.console?.console_id && observation.console_id !== e.lease!.console.console_id) throw new Error('Console instance identity mismatch');
    e.consoleObservation = observation;
    if (e.consoleAttempt && observation.attempt?.attempt_id === e.consoleAttempt.attempt_id && observation.console_id === e.consoleAttempt.console_id) e.consoleAttempt.status = observation.attempt.status;
    await this.save(); return observation;
  }
  private assertConsoleIdentity(observation: ConsoleStatus, e: Enclosure) {
    if (observation.vm !== e.lease!.vm || observation.lease_id !== e.lease!.lease_id) throw new Error('Console lease identity mismatch');
    const fingerprint = this.environment?.identity.fingerprint ?? e.lease!.console?.environment_fingerprint ?? null;
    if (observation.environment_fingerprint !== fingerprint) throw new Error('Console environment identity mismatch');
  }
  consoleResolve(signal?: AbortSignal) { return this.serialized(() => this.resolveConsole(signal)); }
  consoleOpen(input: ConsoleOpenInput, signal?: AbortSignal) { return this.serialized(async () => {
    this.reason(input.reason); this.reason(input.expected);
    if (input.userRequested !== true) throw new Error('Opening requires an explicit user request');
    return this.consoleOperation('open', input, signal);
  }); }
  consoleCancel(input: ConsoleAttemptInput, signal?: AbortSignal) { return this.serialized(() => this.consoleOperation('cancel', input, signal)); }
  private async consoleOperation(operation: 'open' | 'cancel', input: ConsoleAttemptInput | ConsoleOpenInput, signal?: AbortSignal) {
    if (![input.console_id, input.attempt_id].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(v))) throw new Error('Invalid console or attempt identity');
    const resolved = await this.resolveConsole(signal), e = this.current();
    if (!e.lease!.console?.console_id) throw new Error('This lease has no acquired console; automatic VNC retrofit is forbidden');
    if (resolved.console_id !== input.console_id) throw new Error('Console instance identity mismatch');
    const method = operation === 'open' ? this.vm.consoleOpen : this.vm.consoleCancel;
    if (!method) throw new Error('Backend lacks console API; upgrade vm-service');
    if (operation === 'open') {
      if (resolved.viewer_location !== 'service-host') throw new Error('Only a viewer on the declared service host is supported; no remote-client viewer fallback');
      if (e.lease!.state !== 'running' || !Number.isFinite(e.lease!.ttl_expires_at) || e.lease!.ttl_expires_at <= Date.now() / 1000) throw new Error('Console lease is not running or has expired');
      if (resolved.status !== 'ready') throw new Error('Console is not ready or access was revoked; no automatic recovery');
      if (e.consoleAttempt && e.consoleAttempt.attempt_id === input.attempt_id) return { ...resolved, retainedAttempt: e.consoleAttempt, replayed: false, screenshotEvidence: false };
      if (e.consoleAttemptIds?.includes(input.attempt_id)) throw new Error('Console attempt ID was already used; historical launches are never replayed');
      if ((e.consoleAttemptIds?.length ?? 0) >= 64) throw new Error('Console attempt limit reached for this enclosure');
      if (e.consoleAttempt && !['cancelled', 'closed', 'failed', 'expired'].includes(e.consoleAttempt.status)) throw new Error('Previous console attempt remains active or uncertain; resolve or cancel it before requesting a new attempt');
      if (resolved.attempt && !['cancelled', 'closed', 'failed'].includes(resolved.attempt.status)) throw new Error('Backend console attempt remains active or uncertain; resolve or cancel it first');
    }
    const body = { lease_id: e.lease!.lease_id!, console_id: input.console_id, attempt_id: input.attempt_id };
    if (operation === 'cancel' && e.consoleAttempt && e.consoleAttempt.attempt_id !== input.attempt_id && !['cancelled', 'closed', 'failed', 'expired'].includes(e.consoleAttempt.status)) throw new Error('Cancel must identify the active or uncertain owned attempt');
    e.consoleAttemptIds = [...new Set([...(e.consoleAttemptIds ?? []), input.attempt_id])];
    e.consoleAttempt = { console_id: input.console_id, attempt_id: input.attempt_id, status: 'uncertain' };
    // Persist before dispatch. Restore and repeated open never replay a launch.
    await this.save();
    await this.log(`console-${operation}-intent`, 'reason' in input ? input.reason : undefined, { ...body, ...('expected' in input ? { expected: input.expected } : {}), screenshotEvidence: false });
    try {
      const observation = consoleStatus(await method.call(this.vm, e.lease!.vm, body, { signal, timeoutMs: 30000 }));
      this.assertConsoleIdentity(observation, e);
      if (observation.console_id !== body.console_id || observation.attempt?.attempt_id !== body.attempt_id) throw new Error('Console response identity mismatch');
      e.consoleObservation = observation; e.consoleAttempt.status = observation.attempt.status;
      await this.save(); await this.log(`console-${operation}`, undefined, observation);
      return { ...observation, screenshotEvidence: false, leaseReleased: false };
    } catch {
      await this.save();
      throw new Error(`Console ${operation} outcome unknown; ownership retained. Resolve or cancel attempt ${input.attempt_id}; never automatically replay opening.`);
    }
  }
  private reason(because: string) { if (typeof because !== 'string' || !because.trim() || because.length > 4000) throw new Error('reason must be nonblank and at most 4000 characters'); }
  private current() { this.assertBinding(); if (!this.enclosure?.lease || this.enclosure.released) throw new Error('No active lease; use relay action=acquire'); return this.enclosure; }
  private transfer() { const e = this.current(); if (!e.node) throw new Error('Stage runtime first'); return new Transfer(this.channel, e.lease!.vm, e.node, { guestRoot: e.guestRoot, hostTempRoot: join(this.root, 'transfer-tmp'), onRetry: event => this.log('transfer-retry', undefined, event) }); }
  private async log(kind: string, because?: string, details: unknown = {}) {
    if (because !== undefined) this.reason(because);
    const e = this.enclosure;
    if (e) await jsonFile(e.delivered ? join(`${e.hostRoot}.lifecycle-events`, `${Date.now()}-${randomUUID()}.json`) : join(e.hostRoot, 'host', 'events', `${Date.now()}-${randomUUID()}.json`), { kind, because, at: new Date().toISOString(), details });
  }
  acquire(input: AcquireInput, signal?: AbortSignal) { return this.serialized(async () => {
    await this.init(); signal?.throwIfAborted(); await this.assertBackend();
    if (this.shuttingDown) throw new Error('Relay manager is shutting down');
    if (this.enclosure) throw new Error('This enclosure already owns a lease; finish or release it first');
    if (!/^[a-z0-9][a-z0-9-]{0,35}$/.test(input.task)) throw new Error('task must be a lowercase slug (1–36 chars)');
    if (!Array.isArray(input.extractions) || input.extractions.length > 100) throw new Error('Declare up to 100 extractions before work');
    const names = new Set<string>();
    for (const extraction of input.extractions) {
      within('/workspace', extraction.path);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(extraction.name) || names.has(extraction.name)) throw new Error('Extraction names must be unique safe basenames');
      if (extraction.name === 'full-workspace') throw new Error('full-workspace is a reserved extraction name');
      if (extraction.name === BROWSER_CAPTURES && extraction.path !== BROWSER_CAPTURES) throw new Error(`${BROWSER_CAPTURES} is reserved for the guest browser's page captures at workspace/${BROWSER_CAPTURES}`);
      names.add(extraction.name);
    }
    const ttlHours = input.ttlHours ?? 4;
    if (!Number.isFinite(ttlHours) || ttlHours < 0.1 || ttlHours > 720) throw new Error('ttlHours must be 0.1–720');
    const images = await this.vm.images({ timeoutMs: 5000, signal });
    if (!images.images[input.image]?.base_available) throw new Error(`Image unavailable: ${input.image}`);
    if (input.vnc !== undefined && typeof input.vnc !== 'boolean') throw new Error('vnc must be boolean');
    if (input.vnc) {
      const capabilities = await this.readAcquisitionCapabilities(signal);
      if (!capabilities.options.vnc.backends[images.images[input.image]!.kind].available) throw new Error('VNC backend unavailable for this image OS; ordinary acquisition was not attempted');
    }
    const purpose = `relay-${input.task}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const stamp = startedAt.slice(0, 19).replace(/[T:]/g, '-') + '-Z';
    const hostRoot = join(this.options.outputRoot ?? resolve(this.options.project, 'relay-evidence'), purpose);
    const row: RegistryRow = { machine: this.environment ? `${this.environment.profile.vmServiceUrl} (${this.environment.profile.id}; ${purpose})` : `127.0.0.1 (vm-service ${purpose})`, os: input.image, taskName: purpose, agent: `mcp-vm-relay ${this.options.sessionId}`, project: resolve(this.options.project), startDate: stamp };
    this.enclosure = { backend: this.binding(), purpose, task: input.task, image: input.image, project: this.options.project, startedAt, guestRoot: `/var/tmp/${stamp}-mcp-vm-relay-${purpose}`, hostRoot, ttlHours, extractions: input.extractions, fullWorkspace: input.fullWorkspace ?? false, row, staged: false };
    await this.save();
    try {
      await this.registry.add(row);
      await this.log('acquire-intent', undefined, input);
      try { await cp(join(this.root, 'probes'), join(hostRoot, 'host', 'probes'), { recursive: true, errorOnExist: true, force: false }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.enclosure.acquisitionInFlight = true; await this.save();
      try {
        this.enclosure.lease = await this.vm.acquire({ purpose, image: input.image, env: input.env ?? 'none', ttl_hours: ttlHours, wait: true, ...(input.vnc === undefined ? {} : { vnc: input.vnc }) }, { signal });
        this.enclosure.acquisitionInFlight = false;
      } catch (error) {
        if (signal?.aborted && error === signal.reason || error instanceof VmServiceError && error.status !== undefined && error.status >= 400 && error.status < 500) this.enclosure.acquisitionInFlight = false;
        throw error;
      }
      if (this.enclosure.lease?.console) {
        this.enclosure.lease.console = consoleStatus(this.enclosure.lease.console);
        this.enclosure.consoleObservation = this.enclosure.lease.console;
      }
      await this.save(); // keep identity even if registration or cancellation fails
      if (input.vnc && (!this.enclosure.lease?.lease_id || !this.enclosure.lease.console?.console_id || this.enclosure.lease.console.status !== 'ready')) throw new Error('VNC acquisition did not return a ready console and lease identity; ownership retained for reconciliation');
      signal?.throwIfAborted();
      this.enclosure.guestState = this.enclosure.lease!.state;
      this.enclosure.expiresAt = this.enclosure.lease!.ttl_expires_at;
      this.startHeartbeat(); await this.save();
      return { ...this.status(), guestRoot: this.enclosure.guestRoot, workspace: join(this.enclosure.guestRoot, 'workspace'), declarations: input.extractions };
    } catch (error) { await this.fail(error); throw error; }
  }); }
  private startHeartbeat() {
    if (this.timer || !this.enclosure?.lease) return;
    this.enclosure.active = true;
    const ms = this.options.heartbeatMs ?? Math.min(60000, this.enclosure!.ttlHours * 3600000 / 3);
    this.timer = setInterval(() => { void this.heartbeat(); }, ms); this.timer.unref();
  }
  private async heartbeat() {
    const e = this.enclosure;
    if (!e?.lease || e.released || this.heartbeating) return;
    this.heartbeating = true;
    try {
      this.assertBinding(); await this.assertBackend();
      const renewed = await this.vm.heartbeat(e.lease.vm, { ttl_hours: e.ttlHours }, { timeoutMs: 10000 });
      if (this.enclosure !== e || e.released) return;
      e.expiresAt = renewed.ttl_expires_at; e.guestState = renewed.state; await this.save();
    }
    catch (error) {
      if (this.enclosure !== e || e.released) return;
      e.lastError = `Heartbeat lost: ${String(error)}`; e.guestState = 'unknown'; await this.save().catch(() => {});
      void this.serialized(async () => {
        if (this.enclosure !== e || e.released) return;
        try { await this.reconcile(); } catch (failure) { await this.log('heartbeat-uncertain', undefined, { error: String(failure) }).catch(() => {}); }
      }).catch(() => {});
    }
    finally { this.heartbeating = false; }
  }
  private async guarded<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    try {
      if (this.shuttingDown) throw new Error('Relay manager is shutting down');
      await this.init(); signal?.throwIfAborted();
      if (this.shuttingDown) throw new Error('Relay manager is shutting down');
      await this.reconcile(); this.current(); this.startHeartbeat();
      const result = await fn(); signal?.throwIfAborted(); return result;
    } catch (error) { await this.fail(error); throw new Error(`${String(error)}\nVM state: ${JSON.stringify(this.status())}`, { cause: error }); }
  }
  stage(input: StageInput, signal?: AbortSignal) { return this.serialized(() => this.guarded(signal, async () => {
    const e = this.current();
    if (e.delivered) throw new Error('Evidence already sealed; release this VM explicitly');
    if (input.resetRecording || e.pendingReset) await this.resetRecording();
    if (e.staged && (input.workspace || input.files?.length || input.browser)) throw new Error('Runtime already staged; use diagnostic exec for repairs or stage with only corrected executable paths');
    const bundle = this.options.runtimeBundle ?? fileURLToPath(new URL('../dist/receiver.mjs', import.meta.url));
    await access(bundle);
    const node = input.nodePath ?? e.node ?? 'node';
    const transfer = new Transfer(this.channel, e.lease!.vm, node, { guestRoot: e.guestRoot, hostTempRoot: join(this.root, 'transfer-tmp'), onRetry: event => this.log('transfer-retry', undefined, event) });
    await transfer.checked([node, '--version']);
    e.node = node;
    e.cuaDriver = input.cuaDriver ?? e.cuaDriver ?? (e.lease!.image_kind === 'macos' ? '/Applications/CuaDriver.app/Contents/MacOS/cua-driver' : 'cua-driver');
    await this.save();
    if (e.staged) { await this.session?.close(); await this.attach(); return { staged: true, workspace: join(e.guestRoot, 'workspace'), owned: this.status(), files: [], extractions: e.extractions }; }
    await transfer.checked(['/bin/mkdir', '-p', join(e.guestRoot, 'workspace'), join(e.guestRoot, 'state')]);
    const staged = [await transfer.pushFile(bundle, join(e.guestRoot, 'receiver.mjs'))];
    for (const file of input.files ?? []) staged.push(await transfer.pushFile(resolve(this.options.project, file.local), within(join(e.guestRoot, 'support'), file.path), file.local.startsWith('/') ? dirname(resolve(file.local)) : resolve(this.options.project)));
    if (input.workspace) staged.push(...await transfer.pushTree(resolve(this.options.project, input.workspace), join(e.guestRoot, 'workspace'), input.workspace.startsWith('/') ? resolve(input.workspace) : resolve(this.options.project)));
    if (input.browser && !e.browser) {
      const browserBundle = fileURLToPath(new URL('../dist/browser.mjs', import.meta.url));
      staged.push(await transfer.pushFile(browserBundle, join(e.guestRoot, 'browser.mjs')));
      // Page captures (settle-waited landing and snapshot PNGs with their records)
      // land in the workspace and come home as a declared extraction, so the
      // declaration is added here when the agent did not make it on acquire.
      if (!e.extractions.some(item => item.name === BROWSER_CAPTURES)) { e.extractions.push({ path: BROWSER_CAPTURES, name: BROWSER_CAPTURES }); await this.save(); }
      const config = { stateDir: join(e.guestRoot, 'browser'), workspace: join(e.guestRoot, 'workspace'), captureDir: join(e.guestRoot, 'workspace', BROWSER_CAPTURES), settleTimeoutMs: input.browser.settleTimeoutMs, playwrightModule: input.browser.playwrightModule };
      const localConfig = join(e.hostRoot, 'host', 'browser-config.json');
      await jsonFile(localConfig, config);
      await transfer.pushFile(localConfig, join(e.guestRoot, 'browser-config.json'));
      await transfer.checked([node, join(e.guestRoot, 'browser.mjs'), 'start', join(e.guestRoot, 'browser-config.json')], 90000);
      e.browser = true; e.browserConfig = input.browser;
      await this.save();
    }
    await this.log('stage', undefined, { files: staged, extractions: e.extractions });
    const relay = Relay.open(join(e.hostRoot, 'host', 'submissions'));
    this.transport = new VmTransport(transfer, e.guestRoot, join(e.hostRoot, 'host'), e.cuaDriver);
    relay.useTransport(() => this.transport!);
    this.session = await relay.start({ taskId: e.purpose, target: `vm-service:${e.lease!.vm}` });
    e.sessionId = this.session.sessionId; e.staged = true; await this.save();
    return { staged: true, workspace: join(e.guestRoot, 'workspace'), files: staged, extractions: e.extractions, capabilities: { image: imageCapability } };
  })); }
  run(input: RunInput, signal?: AbortSignal) { return this.serialized(() => {
    this.reason(input.because);
    return this.guarded(signal, async () => {
    const e = this.current();
    const timeoutMs = input.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('timeoutMs must be an integer from 1 to 3600000');
    if (input.diagnostic && input.kind !== 'exec') throw new Error('diagnostic is only supported for exec');
    if (e.delivered) throw new Error('Evidence already sealed; release this VM explicitly');
    if (input.diagnostic) return this.diagnostic(input, timeoutMs);
    if (e.pendingReset) throw new Error('Recording reset is pending; retry stage to reconcile it, or use diagnostic exec');
    if (!e.staged || !this.session || !this.transport) throw new Error('Use relay action=stage before action=run, or exec diagnostic=true for setup diagnosis and repair');
    if (!input.step?.id?.trim() || !input.step.title?.trim() || !input.step.expected?.trim()) throw new Error('step id, title and expected result are required');
    if (!input.snapshots || typeof input.snapshots !== 'object') throw new Error('snapshots with an agent-supplied interval is required');
    const interval = input.snapshots.group?.afterIntervalMs ?? input.snapshots.afterIntervalMs;
    if ((!input.snapshots.group || input.snapshots.group.phase === 'last') && (!Number.isFinite(interval) || interval! < 0 || interval! > 300000)) throw new Error('Supply afterIntervalMs between 0 and 300000; no default');
    this.transport.because = input.because;
    this.transport.timeoutMs = timeoutMs;
    this.transport.diagnostic = input.diagnostic ?? false;
    const options = { step: input.step, snapshots: input.snapshots, cwd: join(e.guestRoot, 'workspace') };
    let result;
    if (input.kind === 'exec') {
      if (!input.argv?.length) throw new Error('exec requires argv');
      result = await this.session.exec(input.argv, options);
    } else if (input.kind === 'cua') {
      if (!input.tool) throw new Error('cua requires tool');
      const directAccessibility = input.tool === 'set_value' || (e.lease!.image_kind === 'macos' && input.tool === 'type_text') || (['click', 'double_click', 'right_click', 'press_key'].includes(input.tool) && input.args?.element_index !== undefined);
      if (directAccessibility && input.step.inputMode !== 'accessibility') throw new Error('This CUA form directly uses accessibility APIs. Use real pixel/keyboard input for ordinary tests, or explicitly label inputMode accessibility.');
      result = await this.session.exec([e.cuaDriver!, 'call', input.tool, '--json', JSON.stringify(input.args ?? {})], options);
    } else if (input.kind === 'browser') {
      if (!e.browser || !input.browser) throw new Error('Enable browser support in relay action=stage and supply a browser operation');
      const { action: type, ...args } = input.browser;
      result = await this.session.exec([e.node!, join(e.guestRoot, 'browser.mjs'), 'call', join(e.guestRoot, 'browser'), JSON.stringify({ type, ...args }), String(timeoutMs)], options);
    } else if (input.kind === 'script') {
      if (!input.localPath || !input.language) throw new Error('script requires localPath and language');
      await assertHostPath(input.localPath.startsWith('/') ? dirname(input.localPath) : resolve(this.options.project), resolve(this.options.project, input.localPath));
      result = await this.session.runScript(resolve(this.options.project, input.localPath), join(e.guestRoot, 'scripts', `${randomUUID()}.${input.language === 'python' ? 'py' : input.language === 'typescript' ? 'ts' : 'js'}`), input.language, options);
    } else if (input.kind === 'code') {
      if (typeof input.code !== 'string' || !input.language) throw new Error('code requires code and language');
      result = await this.session.runCode(input.code, input.language, options);
    } else throw new Error('Unknown operation kind');
    const outcome = result.outcome;
    if (outcome.kind !== 'completed' || outcome.exitStatus.code !== 0 || outcome.exitStatus.signal) {
      await this.log('execution-failed', input.because, result);
      await this.fail(new Error(`Execution ${result.executionId}: ${JSON.stringify(outcome)}`));
    }
    const imageDelivery = await this.imageStore().get({ source: 'display', sessionId: e.sessionId!, executionId: result.executionId, phase: 'after' }, signal);
    // The guest's bounded output rides along in the receipt the transport filed.
    // For a browser event the guest program's one-line JSON answer (settle facts,
    // a landing or snapshot capture, a read's text) is parsed out for the agent.
    let browser: unknown;
    if (input.kind === 'browser' && typeof this.transport?.response?.stdout === 'string') {
      try { const parsed = JSON.parse(this.transport.response.stdout.trim().split('\n').at(-1) ?? ''); if (parsed && typeof parsed === 'object' && parsed.ok === true) browser = parsed.result; } catch { /* not the browser program's answer; the raw output is still returned */ }
    }
    return { ...result, ...this.transport?.response, ...(browser !== undefined ? { browser } : {}), timeoutMs, evidencePath: e.hostRoot, leaseReleased: !this.enclosure, owned: this.status(), imageDelivery };
    });
  }); }
  private imageStore() {
    const e = this.current();
    return new ImageStore({ owner: this.options.sessionId, enclosure: e.purpose, backend: e.backend,
      catalogRoot: join(this.root, 'image-catalog', e.purpose), hostRoot: e.hostRoot, guestRoot: e.guestRoot,
      sessionId: e.sessionId, previousEvidence: e.previousEvidence, declarations: e.extractions, transfer: this.transfer(),
      ensureGuest: async (signal, deadline) => {
        const options = { signal, timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())) };
        if (this.environment) {
          const health = await this.vm.health(options);
          if (!health.ok || !matchesEnvironment(health.environment, this.environment)) throw Object.assign(new Error('Selected backend identity changed.'), { code: 'unauthorized-reference' });
        }
        try {
          const lease = await this.vm.get(e.lease!.vm, options);
          if (lease.purpose !== e.purpose) throw Object.assign(new Error('Lease ownership identity changed.'), { code: 'unauthorized-reference' });
        } catch (error) {
          if (error instanceof VmServiceError && error.status === 404) throw Object.assign(new Error('Saved image guest is no longer available.'), { code: 'stale-reference' });
          throw error;
        }
      } });
  }
  image(target: ImageTarget, signal?: AbortSignal): Promise<ImageResult> {
    const deadline = Date.now() + 90000;
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90000)]);
    return this.serialized(async () => {
    if (bounded.aborted) return { status: 'transfer-failed', diagnostic: 'Image delivery cancelled or deadline exceeded before starting.' };
    await this.init(true); this.assertBinding();
    if (bounded.aborted) return { status: 'transfer-failed', diagnostic: 'Image delivery cancelled or deadline exceeded while loading ownership.' };
    // Verified local image recovery must not depend on a reachable guest. The
    // private catalog still requires this manager's owner lock and enclosure.
    if (!this.enclosure || this.enclosure.released || this.enclosure.delivered) return { status: 'stale-reference', diagnostic: 'Enclosure is closed or sealed; inspect delivered originals with the host read tool.' };
    return this.imageStore().get(target, bounded, deadline);
  }); }
  private async resetRecording() {
    const e = this.current();
    if (!e.staged || !e.sessionId) throw new Error('Recording reset requires a staged recording');
    if (!e.pendingReset) {
      const id = randomUUID();
      e.pendingReset = { id, from: e.hostRoot, fromSession: e.sessionId, to: `${e.hostRoot}-recording-${id.slice(0, 8)}` };
      await this.save();
    }
    const reset = e.pendingReset;
    const transfer = this.transfer();
    const archive = join(e.guestRoot, 'recordings', reset.id);
    // Check the reset marker before selecting the immutable source to preserve.
    const marker = await transfer.checked([e.node!, '-e', 'const fs=require("fs"),p=require("path");console.log(fs.existsSync(p.join(process.argv[1],"recordings",process.argv[2]))?"archived":"current");', e.guestRoot, reset.id]);
    const attempts = `${reset.from}.reset-attempts`;
    const incoming = join(attempts, randomUUID(), 'state');
    await transfer.pullVerified(marker.trim() === 'archived' ? archive : join(e.guestRoot, 'state'), incoming, e.guestRoot, attempts);
    await this.imageStore().materializeDisplayOriginals(reset.from);
    await refreshEvidenceState(incoming, join(reset.from, 'state'), join(attempts, 'previous'));
    await this.log('recording-reset-intent', undefined, reset);
    // The operation is deliberately idempotent for this persisted reset ID. It
    // never replays input and never deletes old state or an ambiguous live lock.
    await transfer.checked([e.node!, '-e', `const fs=require('fs'),p=require('path');const [root,id]=process.argv.slice(1);if(fs.existsSync(p.join(root,'.receiver-lock')))throw Error('Receiver lock exists; diagnose active execution before recording reset');const state=p.join(root,'state'),archive=p.join(root,'recordings',id),marker=p.join(root,'.recording-reset-'+id+'.json');if(!fs.existsSync(marker)){fs.mkdirSync(p.dirname(archive),{recursive:true});if(!fs.existsSync(archive))fs.renameSync(state,archive);else if(fs.existsSync(state)&&fs.readdirSync(state).length)throw Error('Reset destination is not empty');fs.mkdirSync(state,{recursive:true});fs.writeFileSync(marker,JSON.stringify({id,archive}),{flag:'wx'});}console.log('recording archived');`, e.guestRoot, reset.id]);
    await this.session?.close(); this.session = undefined; this.transport = undefined;
    e.previousEvidence = [...(e.previousEvidence ?? []), { path: reset.from, sessionId: reset.fromSession, guestState: archive }];
    e.hostRoot = reset.to; e.staged = false; e.sessionId = undefined; delete e.pendingReset;
    await this.save();
    await this.log('recording-resumed', undefined, { previousEvidence: e.previousEvidence });
  }
  private async extractInternal(names: string[]) {
    const e = this.current(), transfer = this.transfer(); const results = [];
    for (const name of names) {
      const declaration = e.extractions.find(item => item.name === name);
      if (!declaration) throw new Error(`Undeclared extraction: ${name}`);
      const destination = join(e.hostRoot, 'extractions', name, randomUUID());
      const facts = await transfer.pullVerified(within(join(e.guestRoot, 'workspace'), declaration.path), destination, join(e.guestRoot, 'workspace'), e.hostRoot);
      results.push({ ...declaration, destination, facts });
    }
    await jsonFile(join(e.hostRoot, 'host', 'extractions', `${randomUUID()}.json`), { extractions: results });
    return results;
  }
  extract(names: string[], signal?: AbortSignal) { return this.serialized(() => this.guarded(signal, async () => {
    if (this.current().delivered) throw new Error('Evidence already sealed; no further extractions may modify it');
    await this.log('extract', undefined, { names }); return this.extractInternal(names);
  })); }
  private async extractAvailable() {
    const e = this.current();
    for (const extraction of e.extractions) {
      try { await this.extractInternal([extraction.name]); }
      catch (error) { await this.log('extraction-incomplete', undefined, { name: extraction.name, error: String(error) }).catch(() => {}); }
    }
    if (e.fullWorkspace) {
      try { await this.transfer().pullVerified(join(e.guestRoot, 'workspace'), join(e.hostRoot, 'extractions', 'full-workspace', randomUUID()), e.guestRoot, e.hostRoot); }
      catch (error) { await this.log('workspace-incomplete', undefined, { error: String(error) }).catch(() => {}); }
    }
  }
  private async packageInternal() {
    const e = this.current();
    if (!e.staged || !e.sessionId) throw new Error('No staged session to package');
    const attempts = `${e.hostRoot}.finalization-attempts`;
    const incoming = join(attempts, randomUUID(), 'state');
    await this.transfer().pullVerified(join(e.guestRoot, 'state'), incoming, e.guestRoot, attempts);
    await this.imageStore().materializeDisplayOriginals(e.hostRoot);
    await refreshEvidenceState(incoming, join(e.hostRoot, 'state'), join(attempts, 'previous'));
    const result = await deliverPackage(e.hostRoot, { packageId: `pkg-${e.purpose}`, sessionId: e.sessionId, taskId: e.purpose });
    e.delivered = result; await this.save(); return result;
  }
  finish(signal?: AbortSignal) { return this.serialized(() => this.guarded(signal, async () => {
    const e = this.current(); await this.log('finish');
    if (!e.delivered) {
      await this.extractInternal(e.extractions.map(item => item.name));
      if (e.fullWorkspace) await this.transfer().pullVerified(join(e.guestRoot, 'workspace'), join(e.hostRoot, 'extractions', 'full-workspace', randomUUID()), e.guestRoot, e.hostRoot);
    }
    const result = e.delivered ?? await this.packageInternal();
    await this.releaseInternal('finished'); return result;
  })); }
  private async fail(error: unknown) {
    const e = this.enclosure; if (!e || !this.bindingMatches(e)) return;
    e.lastError = String(error);
    await this.save();
    await this.log('operation-failed', undefined, { error: String(error), leaseRetained: !e.released });
  }
  private async diagnostic(input: RunInput, timeoutMs: number) {
    const e = this.current();
    if (!input.argv?.length || input.snapshots.group) throw new Error('Diagnostic exec requires argv and cannot join a snapshot group');
    const executionId = `diagnostic-${randomUUID()}`;
    const request = { executionId, at: new Date().toISOString(), evidenceMode: 'diagnostic', timeoutMs, ...input };
    await jsonFile(join(e.hostRoot, 'host', 'diagnostics', `${executionId}.request.json`), request);
    let result;
    try {
      const argv = e.staged ? ['/bin/sh', '-c', 'cd "$1" || exit; shift; exec "$@"', 'relay-diagnostic', join(e.guestRoot, 'workspace'), ...input.argv] : input.argv;
      const r = await this.channel.exec(e.lease!.vm, argv, timeoutMs);
      result = { executionId, outcome: { kind: 'completed' as const, exitStatus: { code: r.code, signal: null } }, stdout: r.stdout, stderr: r.stderr };
    } catch (error) { result = { executionId, outcome: { kind: 'uncertain' as const, diagnostic: String(error) }, stdout: '', stderr: String(error) }; }
    const response = { ...result, timeoutMs, evidenceMode: 'diagnostic', screenshotEvidence: false, imageDelivery: { status: 'not-requested' as const, diagnostic: 'Diagnostic execution has no screenshot evidence.' }, evidencePath: e.hostRoot, leaseReleased: false, owned: this.status() };
    await jsonFile(join(e.hostRoot, 'host', 'diagnostics', `${executionId}.receipt.json`), response);
    if (result.outcome.kind !== 'completed' || result.outcome.exitStatus.code !== 0) await this.fail(new Error(JSON.stringify(result.outcome)));
    return response;
  }
  release() { return this.serialized(async () => {
    await this.init(); this.assertBinding(); await this.assertBackend();
    try {
      await this.log('release');
      if (this.enclosure?.staged && !this.enclosure.delivered) { await this.extractAvailable(); await this.packageInternal(); }
    } catch (error) {
      if (this.enclosure) await jsonFile(`${this.enclosure.hostRoot}.delivery-error.json`, { error: String(error) }).catch(() => {});
    } finally { await this.releaseInternal('released'); }
    return this.status();
  }); }
  private async releaseInternal(reason: 'finished' | 'failed' | 'released') {
    this.assertBinding(); await this.assertBackend();
    const e = this.enclosure; if (!e) return;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (!e.released) {
      if (!e.lease) {
        const list = await this.vm.list({ timeoutMs: 10000 });
        const matches = Object.values(list.vms).filter(lease => lease.purpose === e.purpose);
        if (matches.length > 1) throw new Error('Ambiguous acquisition; refusing to remove ownership record');
        if (!matches.length && e.acquisitionInFlight) throw new Error(`Acquire outcome still indeterminate for ${e.purpose}; ownership record retained at ${this.root}. Reconcile before retrying; never blindly acquire again.`);
        e.lease = matches[0]; await this.save().catch(() => {});
      }
      if (e.lease) {
        let released = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { const response = await this.vm.release(e.lease.vm, { reason }, { timeoutMs: 120000 }); if (!response.released) throw new Error('vm-service did not confirm destruction'); released = true; break; }
          catch (error) {
            await this.log('release-error', undefined, { vm: e.lease.vm, cause: reason, attempt: attempt + 1, error: String(error) }).catch(() => {});
            try { await this.vm.get(e.lease.vm, { timeoutMs: 5000 }); }
            catch (getError) { if (getError instanceof VmServiceError && getError.status === 404) { released = true; break; } }
            if (attempt === 2) throw error;
          }
        }
        if (!released) throw new Error('Lease release unconfirmed');
        if (!await this.destroyed(e.lease.vm)) throw new Error(`vm-service relinquished ${e.lease.vm}, but Tart still lists it. Destruction is unverified; ownership retained. See docs/verification.md dependency limitation.`);
      }
      e.released = true; await this.save().catch(() => {});
    }
    await this.registry.remove(e.row);
    await this.session?.close(); this.session = undefined; this.transport = undefined;
    await jsonFile(`${e.hostRoot}.lifecycle.json`, { purpose: e.purpose, vm: e.lease?.vm, released: true, reason, failed: e.failed, delivered: e.delivered, finishedAt: new Date().toISOString() }).catch(() => {});
    this.enclosure = undefined; await this.save();
  }
  private async destroyed(vm: string): Promise<boolean> {
    if (this.options.verifyDestroyed) return this.options.verifyDestroyed(vm);
    // Read-only host observation, not a second guest/transfer channel. The daemon
    // currently drops its lease even when Tart deletion fails; 404 is not proof.
    const result = await command([this.tartPath, 'list', '--format', 'json'], { timeoutMs: 15000, maxBytes: 4 * 1024 * 1024, env: { ...process.env, ...(this.environment ? environmentVariables(this.environment) : {}), TART_HOME: this.tartHome } });
    if (result.code !== 0) throw new Error(`Cannot verify VM destruction: ${result.stderr}`);
    const entries: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.Name !== 'string')) throw new Error('Invalid Tart inventory; destruction not verified');
    return !entries.some(entry => entry.Name === vm);
  }
  private async pause(reason: string) {
    this.assertBinding();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.enclosure) { this.enclosure.active = false; await this.save(); await this.log('renewal-paused', undefined, { reason, expiresAt: this.enclosure.expiresAt ?? this.enclosure.lease?.ttl_expires_at }); }
  }
  async settle() { return this.serialized(() => this.pause('Agent settled; VM retained until explicit release or backend expiration')); }
  async cleanup(reason: string) { return this.serialized(async () => {
    this.shuttingDown = true;
    try { await this.pause(reason); await this.session?.close(); this.session = undefined; this.transport = undefined; }
    finally { this.initialized = false; await this.unlock(); }
  }); }
}
