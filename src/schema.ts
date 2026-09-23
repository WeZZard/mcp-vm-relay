import { Type, StringEnum } from './typebox.js';
import type { Static, TSchema } from 'typebox';
import { Check } from 'typebox/value';

const closed = { additionalProperties: false };
const reason = Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S', description: 'Intent of this execution. Retained as evidence, never identity, authorization or a retry key.' });
const interval = Type.Number({ minimum: 0, maximum: 300000, description: 'Agent-chosen wait in milliseconds from dispatch completion to after-capture. Required per event or on group last. No default or stability polling; choose for text echo, dialog or game semantics.' });
const id = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$' });
const snapshots = Type.Object({
  afterIntervalMs: Type.Optional(interval),
  group: Type.Optional(Type.Object({ groupId: id, phase: StringEnum(['first', 'member', 'last'] as const), afterIntervalMs: Type.Optional(interval) }, closed)),
}, { ...closed, description: 'Standalone event requires afterIntervalMs. Explicit consecutive text group uses first/member/last; last requires an interval. No inferred groups.' });
const step = Type.Object({ id, title: Type.String({ minLength: 1, maxLength: 500 }), expected: Type.String({ minLength: 1, maxLength: 4000 }), inputMode: StringEnum(['ordinary', 'accessibility'] as const) }, closed);
const imageTarget = Type.Union([
  Type.Object({ source: Type.Literal('display'), sessionId: id, executionId: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$' }), phase: StringEnum(['before', 'after'] as const) }, closed),
  Type.Object({ source: Type.Literal('application'), name: Type.String({ minLength: 1, maxLength: 101 }), path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })) }, closed),
  Type.Object({ source: Type.Literal('reference'), imageId: Type.String({ pattern: '^image-[a-f0-9]{64}$' }) }, closed),
]);
const argv = Type.Array(Type.String(), { minItems: 1, maxItems: 256 });
const language = StringEnum(['javascript', 'typescript', 'python'] as const);
const timeoutMs = Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000, description: 'Execution timeout in milliseconds, default 120000, maximum 3600000. Independent of snapshot delay and lease TTL.' }));
const runBase = { action: Type.Literal('run'), reason, step, snapshots, timeoutMs };
const browserEvent = Type.Union([
  Type.Object({ action: Type.Literal('navigate'), url: Type.String({ minLength: 1 }) }, closed),
  Type.Object({ action: Type.Literal('click'), selector: Type.String({ minLength: 1 }) }, closed),
  Type.Object({ action: Type.Literal('type'), selector: Type.String({ minLength: 1 }), text: Type.String() }, closed),
  Type.Object({ action: Type.Literal('press'), key: Type.String({ minLength: 1 }), selector: Type.String({ minLength: 1 }) }, closed),
  Type.Object({ action: Type.Literal('read'), selector: Type.String({ minLength: 1 }) }, closed),
  Type.Object({ action: Type.Literal('snapshot'), name: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$', description: 'Short safe name for this page capture.' })) }, { ...closed, description: 'Capture the live page now: settle-waited PNG plus a record with the console lines since the last capture.' }),
]);
// Authoritative discriminated contract. Even if a provider only exposes the
// object-shaped projection, every invocation is checked here before dispatch.
export const relayContract = Type.Union([
  Type.Object({ action: Type.Literal('search'), name: Type.String({ minLength: 1, maxLength: 256, pattern: '\\S' }), os: Type.Optional(StringEnum(['linux', 'macos'] as const)) }, closed),
  Type.Object({ action: Type.Literal('acquisition-capabilities') }, closed),
  Type.Object({ action: Type.Literal('console-resolve') }, closed),
  Type.Object({ action: Type.Literal('console-open'), console_id: id, attempt_id: id, userRequested: Type.Literal(true), reason, expected: Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S' }) }, closed),
  Type.Object({ action: Type.Literal('console-cancel'), console_id: id, attempt_id: id }, closed),
  Type.Object({ action: Type.Literal('probe'), scope: Type.Optional(StringEnum(['host', 'guest'] as const)) }, closed),
  Type.Object({ action: Type.Literal('acquire'),
    task: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,35}$' }),
    image: Type.String({ description: 'Image key from relay action=probe, e.g. ubuntu2404 or macos26.' }),
    extractions: Type.Array(Type.Object({ path: Type.String({ description: 'Relative guest-workspace path; no traversal or symlinks.' }), name: Type.String({ description: 'Unique output basename.' }) }, closed), { maxItems: 100 }),
    vnc: Type.Optional(Type.Boolean({ description: 'Prepare guest console sharing, default false. Never opens a viewer automatically.' })),
    ttlHours: Type.Optional(Type.Number({ minimum: 0.1, maximum: 720 })),
    env: Type.Optional(Type.String({ description: 'Credential pack, default none; never baked into images.' })),
    fullWorkspace: Type.Optional(Type.Boolean({ description: 'Explicit opt-in to deliver the entire workspace.' })),
  }, closed),
  Type.Object({ action: Type.Literal('stage'),
    resetRecording: Type.Optional(Type.Boolean({ description: 'Explicitly archive the current recording and start a new session on the same VM. Retains prior evidence; refuses while the receiver lock exists. Use after diagnosing recording damage.' })),
    workspace: Type.Optional(Type.String({ description: 'Host directory copied to the guest workspace, opt-in.' })),
    files: Type.Optional(Type.Array(Type.Object({ local: Type.String(), path: Type.String({ description: 'Relative destination under guest support/.' }) }, closed))),
    nodePath: Type.Optional(Type.String({ description: 'Guest Node executable, default node; use image nvm path if needed.' })),
    cuaDriver: Type.Optional(Type.String({ description: 'Guest CUA executable; OS default when omitted.' })),
    browser: Type.Optional(Type.Object({ playwrightModule: Type.Optional(Type.String({ description: 'Guest Playwright module path; default resolution from workspace. No install or CDP attachment.' })), settleTimeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 60000, description: 'Longest wait for the page to settle (load, network idle, fonts, two frames) before each page capture; default 5000.' })) }, { ...closed, description: 'Enable fresh persistent guest Chromium; empty object enables defaults.' })),
  }, closed),
  Type.Object({ ...runBase, kind: Type.Literal('exec'), argv, diagnostic: Type.Optional(Type.Boolean({ description: 'Explicit command diagnosis or repair without screenshot evidence, including before staging. Commands and outcomes remain recorded. Never claim visual verification.' })) }, closed),
  Type.Object({ ...runBase, kind: Type.Literal('script'), localPath: Type.String({ minLength: 1 }), language }, closed),
  Type.Object({ ...runBase, kind: Type.Literal('code'), code: Type.String({ maxLength: 1048576 }), language }, closed),
  Type.Object({ ...runBase, kind: Type.Literal('cua'), tool: Type.String({ minLength: 1 }), args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }, closed),
  Type.Object({ ...runBase, kind: Type.Literal('browser'), browser: browserEvent }, closed),
  Type.Object({ action: Type.Literal('image'), target: imageTarget }, closed),
  Type.Object({ action: Type.Literal('extract'), names: Type.Array(Type.String()) }, closed),
  Type.Object({ action: Type.Literal('finish') }, closed),
  Type.Object({ action: Type.Literal('release') }, closed),
]);
// Root object projection keeps common provider tool requirements satisfied;
// anyOf retains the exact closed branches, rather than accepting arbitrary
// combinations of the optional projected properties.
const projected: Record<string, TSchema> = {};
for (const branch of relayContract.anyOf) {
  for (const [key, schema] of Object.entries(branch.properties)) {
    if (key === 'action') continue;
    const previous = projected[key];
    projected[key] = previous && JSON.stringify(previous) !== JSON.stringify(schema)
      ? Type.Optional(Type.Union([previous, schema])) : Type.Optional(schema);
  }
}
const parameterObject = Type.Object({
  action: StringEnum(['search', 'probe', 'acquire', 'stage', 'run', 'image', 'extract', 'finish', 'release', 'acquisition-capabilities', 'console-resolve', 'console-open', 'console-cancel'] as const),
  ...projected,
}, { ...closed, anyOf: relayContract.anyOf, description: 'Select exactly one action. Each closed branch defines allowed fields. Run requires reason and selects a kind; console-open requires reason, expected and userRequested=true. Other actions reject reason. No default action.' });

export type RelayInput = Static<typeof relayContract>;
export const relayParameters = Type.Unsafe<RelayInput>(parameterObject);
export type RelayAction = RelayInput['action'];
export const relayActions = ['search', 'probe', 'acquire', 'stage', 'run', 'image', 'extract', 'finish', 'release', 'acquisition-capabilities', 'console-resolve', 'console-open', 'console-cancel'] as const;

export function validateRelayInput(value: unknown): asserts value is RelayInput {
  if (!Check(relayContract, value)) throw new Error('Invalid relay input: action is required; run and console-open require nonblank reason. Supply only the fields for the selected action and run kind.');
  if (value.action === 'run') {
    const s = value.snapshots;
    if (value.kind === 'exec' && value.diagnostic && s.group) throw new Error('Diagnostic commands cannot join snapshot groups.');
    if (!s.group && s.afterIntervalMs === undefined) throw new Error('Standalone run requires snapshots.afterIntervalMs; no default interval.');
    if (s.group?.phase === 'last' && s.group.afterIntervalMs === undefined && s.afterIntervalMs === undefined) throw new Error('Last text-group member requires afterIntervalMs.');
  }
}
