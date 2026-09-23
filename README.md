# mcp-vm-relay

The Model Context Protocol front end of the VM relay, packaged as a Claude Code
plugin and as a pi package. [pi-vm-relay](https://github.com/WeZZard/pi-vm-relay),
which gave pi a native `relay` tool directly, is retired; mcp-vm-relay replaces
it for both Claude Code and pi, the latter loaded through `pi-mcp-adapter`. It
offers one `relay` tool: recorded, snapshot-evidenced **interruptive**
computer-use and browser-use in a fresh, dedicated VM. The agent judges
interruption; non-disruptive work stays with the agent's local tools. Nothing
here executes local computer-use, spawns subagents, targets physical machines,
records video, or attaches to existing browsers.

## How it is built

The relay implementation lives in this repository: the manager
(`src/manager.ts`), the vm-service client, the registry with its OS-level lock,
the guest transfer and transport, the evidence package and its state merge, the
selected-environment profile, the console and saved-image contracts, the strict
tool contract (`src/schema.ts`), the action dispatch and bounded result
rendering (`src/surface.ts`), and the two guest programs
(`src/guest/receiver.ts`, `src/guest/browser.ts`). It was inherited from
[pi-vm-relay](https://github.com/WeZZard/pi-vm-relay) at commit 8990123,
synchronized with its implementation through commit 0d69fc7 before that
project's retirement, and is maintained here as mcp-vm-relay's own
implementation from then on. `src/server.ts` binds the core to MCP over
standard input and output.

The committed `dist/` holds `server.mjs` (the MCP server with the core bundled
in), the guest bundles the manager stages (`receiver.mjs`, `browser.mjs`) and
the doctor. Compiled [relay-driver](https://github.com/WeZZard/relay-driver)
code, the recorded-execution and evidence substrate, is bundled with hashes and
provenance in `dist/build-info.json`. Consumers load `dist/`; no build, SDK
checkout or network fetch happens at install time.

The Claude Code plugin provides what pi-vm-relay's native extension hooks used
to provide in pi. pi itself now reaches this same server as an MCP tool
through `pi-mcp-adapter` (see "Use with pi" below), so the `relay` tool's
identity and contract are shared; only the doctrine/skill/hook delivery
mechanism below is Claude-Code-specific.

| In pi-vm-relay (retired, native pi extension) | Here (Claude Code plugin) |
|---|---|
| a registered `relay` tool | MCP tool `relay` from the server `vm-relay` in `.mcp.json` |
| doctrine injected before each agent turn | `hooks/hooks.json` session-start hook printing `server.mjs --doctrine`, and the `vm-relay` skill |
| `/relay-status`, `/relay-trajectory` commands | skills `/relay-status` and `/relay-trajectory`, backed by the operator tools `relay_status` and `relay_trajectory` |
| prompt-composed enclosure | the `vm-relay-operator` agent definition, limited to the relay tools and read-only file tools |
| typed image blocks in a run result, with pi's `tool_result` hook keeping the error flag | MCP image content blocks in the tool result, with the MCP `isError` flag set beside them |
| session shutdown pauses lease renewal | the same when the server's stdio closes or it is signalled: renewal pauses, the recording detaches, the VM is retained for an explicit `finish` or `release`, and the vm-service TTL is the backstop |
| the settled agent pauses renewal | none: MCP has no such hook, so the skill and agent say "finish or release before you return" |

## Install

### Use with Claude Code

Try it from a checkout:

```sh
claude --plugin-dir /path/to/mcp-vm-relay
```

Or add this repository as a marketplace and install the plugin from it:

```
/plugin marketplace add WeZZard/mcp-vm-relay
/plugin install mcp-vm-relay@wezzard
```

Once loaded, the model sees the tools as
`mcp__plugin_mcp-vm-relay_vm-relay__relay`, `…__relay_status` and
`…__relay_trajectory`. A subagent definition allows them by those names. The server
can also be configured directly in a project's `.mcp.json` with
`node /path/to/mcp-vm-relay/dist/server.mjs`, in which case the tools are
`mcp__vm-relay__relay` and so on.

### Use with pi

```sh
pi install npm:@wezzard/mcp-vm-relay
```

This needs `pi-mcp-adapter` installed. The tool appears as `relay`, with the
two operator tools as `relay_status` and `relay_trajectory`, with no host-specific
prefix.

### Use with npx

```sh
npx -y @wezzard/mcp-vm-relay
```

This runs the MCP server directly on stdio, for a client that speaks MCP
without a Claude Code plugin or pi package wrapper.

### Prerequisites

Node 22+, Python 3 with `fcntl` for the registry lock, and for VM execution an
Apple-silicon Mac with Tart, a running
[vm-service](https://github.com/WeZZard/vm-service) and prepared guest images.
Check readiness with `node dist/doctor.mjs`. It does not acquire a VM or
establish guest UI readiness. Guest execution needs Node and CuaDriver with
capture/input permissions; Linux requires native X11 and `serve --no-overlay`,
and browser actions additionally require guest Playwright and bundled
Chromium. Console viewing needs the vm-service guest-sharing backend and its
guest preparation; see `docs/console.md` here.

## The tools

`relay` takes one required `action`. `run` and `console-open` accept and
require a `reason`; the other actions reject it and record structured lifecycle
facts. The contract, the evidence and the snapshot rules follow pi-vm-relay's
design. One difference in what the model is shown: the relay contract is a root
object with a root-level `anyOf` of strict per-action branches, and the
Anthropic API drops a root `anyOf`, so this server offers the projected object
and enforces the strict branches on every call before dispatch.

| `action` | Purpose |
|---|---|
| `search` | Find installed applications from image inventories by name and optional OS. |
| `probe` | Default `scope: "host"` reports host facts, service availability and owned state. `scope: "guest"` checks the Node and CuaDriver executables on the owned guest without claiming capture or browser readiness. |
| `acquisition-capabilities` | Read versioned acquisition options (VNC backends) without allocation or ownership recovery. |
| `acquire` | Register the task, acquire a fresh VM and start its heartbeat; declare outputs before work. Optional `vnc` prepares sharing without opening a viewer. |
| `console-resolve` | Resolve non-secret console status for the owned lease and environment. |
| `console-open` | Open explicitly user-requested viewing on the service host, with `console_id`, `attempt_id`, `userRequested: true`, `reason` and `expected`. |
| `console-cancel` | Cancel the identified viewing attempt without releasing the VM. |
| `stage` | Push and hash-check the runtime, support files, an opt-in workspace and the optional browser. Failed staging can be retried; a staged runtime accepts corrected executable paths; `resetRecording: true` archives the recording and starts a new one on the same VM. |
| `run` | One recorded exec, script, code, CUA or browser operation with optional `timeoutMs`. `exec` with `diagnostic: true` records command diagnosis or repair without screenshot evidence, including before staging. |
| `image` | Retrieve one saved display image, declared application image or immutable image reference without input, capture, directory export or acquisition. |
| `extract` | Pull only declared files or directories with source and host checksum verification. |
| `finish` | Extract declared outputs, deliver and verify the snapshot package, destroy the VM and unregister. |
| `release` | Retain available evidence and abandon or destroy the VM. |

A `run` result carries the execution identity and outcome, the guest's bounded
standard output and error, for a browser event the parsed browser answer (the
settle facts, the landing or snapshot capture, or the text a `read` returned),
and, when the snapshot plan captured the after phase and delivery succeeded,
the saved after-image as an MCP image content block. The full receipt stays in
the evidence package.

`relay_status` returns this session's owned lease with its backend binding,
guest state, renewal state, console observation and last error, the staging
state and evidence path, plus the project directory, the VM service origin and
the selected environment; `{"active": false}` when nothing is owned.
`relay_trajectory` verifies a delivered evidence package (every artifact, hash
and reference) and opens its trajectory viewer in the local human-facing
browser; human review remains pending.

## Ownership, failure and recovery

- One server session owns at most one VM. Another task needs a separate acquisition.
- An operation failure retains the VM so the agent can inspect, repair and submit a new operation. Failed and uncertain operations are never automatically replayed.
- Use `finish` to deliver evidence and release, or `release` to abandon explicitly. A failed delivery retains the VM; a release failure retains ownership until destruction is verified.
- When the session ends (the server's stdio closes or it is signalled), lease renewal pauses and the recording detaches; the VM is not destroyed. The backend TTL and grace period handle abandoned leases. Status reports the last confirmed expiration time.
- A restarted server with the same `MCP_VM_RELAY_SESSION` reconciles its durable ownership and reattaches the recording session without replaying prior work. Context compaction does not reset VM state; `probe` reports the owned state without relying on earlier messages.
- `run.timeoutMs` defaults to 120,000 ms and accepts integers up to 3,600,000 ms. It bounds command execution, not the snapshot delay or the lease lifetime. A timeout reports confirmed termination or uncertainty and keeps the VM available.
- `run` with `kind: "exec"` and `diagnostic: true` records command diagnosis or repair without screenshots, for explicitly requested diagnosis when capture is unavailable. Before staging it runs through vm-service in the guest's default directory; after staging in the recording workspace. It cannot join a snapshot group and is not visual verification.
- After diagnosing damaged recording state, `stage` with `resetRecording: true` archives the old recording and starts a new recording session in the same VM. An existing receiver lock refuses the reset until its operation is reconciled. Prior evidence paths remain in the owned status.

## Browser events and page captures

Enable `browser: {}` in `stage` for a persistent fresh **guest** Playwright
page; the workspace must have Playwright available, or supply an absolute guest
`browser.playwrightModule` path. A `run` with `kind: "browser"` sends one event:
`navigate`, `click`, `type`, `press`, `read`, or `snapshot`. The guest-owned
server keeps the same page across calls, so the after-snapshot shows the live
result. It uses Playwright-managed bundled Chromium, never host Chrome or CDP.
Each event carries the run's `timeoutMs` as its own deadline; an event that
misses it, or whose caller disconnects, has its browser context closed so
pending input cannot land later, and the next event uses a fresh page. Nothing
is replayed.

The desktop snapshot pair is captured after a fixed, agent-declared interval.
A web page is also captured from inside the browser, where the timing can be
tied to the page's own state:

- After every input event (`navigate`, `click`, `type`, `press`) the guest
  server waits for the page to settle: the load event when the page navigated,
  then network idle, then loaded fonts, then two animation frames. The wait is
  bounded by `browser.settleTimeoutMs` (default 5000, at most 60000) and by what
  the event's deadline leaves for the capture, and the facts of the wait
  (`loaded`, `networkIdle`, `fontsReady`, `timedOut`, `waitedMs`) come back with
  the event as `settled`.
- An event that moved the page to a new address gets a **landing** capture of
  where it arrived. A `snapshot` event captures the settled page on demand, with
  an optional short `name`.
- Each capture is a PNG of the viewport plus a JSON record beside it, named
  `c<seq>-<ISO-8601Z>-<landing|snapshot>-<name>`. The record holds the settle
  facts, the operation, the file's SHA-256 and the console lines (including
  page errors) the page emitted since the previous capture.
- Captures land in `workspace/browser-captures`. Staging the browser declares
  that directory as the extraction `browser-captures` when the agent did not,
  so `finish` carries the captures home under `extractions/` as byte-verified
  application attachments, and `image` can retrieve one of them by name and
  relative path. The dispatch-time snapshot pair contract is unchanged.
- A capture that fails after the input was dispatched is an error whose
  response says `dispatched: true`; the run is then refused as any nonzero
  browser event is.

## Saved images

A normal `run` returns its saved after-image as a typed image block whenever the
snapshot plan captures that phase: a standalone event or a text group's last
event. A first or intermediate group event and a diagnostic command do not
invent an image. Execution and image delivery are independent outcomes: a
completed command can have a failed delivery, and a delivered image does not
turn a failed command into a successful one. Either failure sets the MCP
`isError` flag while the content, image included, is kept. The delivery
identity (`imageDelivery`) leads the result text so it survives truncation.

If inline delivery fails, `image` retrieves the same saved image through one
closed selector; it never repeats input, creates a capture, exports the
consumer directory or acquires a VM:

```json
{"action":"image","target":{"source":"display","sessionId":"<recording-session>","executionId":"<saved-execution>","phase":"after"}}
{"action":"image","target":{"source":"application","name":"browser-captures","path":"c000001-…-landing-navigate.png"}}
{"action":"image","target":{"source":"reference","imageId":"image-<64 lowercase hex digits>"}}
```

- Display selection needs `before` or `after`; a phase the plan did not request returns `not-requested`. Application selection needs an acquisition-time declaration: a directory declaration takes one relative file path, a file declaration omits `path`. A reference resolves to the same original bytes or an explicit failure.
- Originals are limited to 64 MiB, 40,000,000 decoded pixels and 32,768 pixels per dimension; PNG, JPEG and WebP are accepted. The preview is at most 2,000 × 2,000 pixels and 4 MiB of base64. **Presentation differs from pi here:** pi resizes through its own image helper, while this core has no codec dependency. A PNG original is decoded and, when it exceeds the preview bounds, resampled in-process (area averaging, `node:zlib`); a JPEG or WebP original has its container validated and passes through unchanged when within bounds, and is reported `presentation-unavailable` otherwise. No EXIF orientation is applied; dimensions are those stored. The presentation receipt records the policy, the original and preview dimensions, the MIME type, hash, size and whether bytes were transformed, beside the untouched original.
- Each delivery has a 90-second deadline and a shared budget of three byte-transfer attempts. Only transient transfer failures are retried; authorization, unsafe-path, capture, format and integrity failures are not. Recommend at most two explicit recovery calls for the same reference; if a required image still cannot be inspected, stop exploratory input and finish or release.
- Immutable catalog entries bind each reference to the owner, enclosure, backend and original identity. Closed or sealed enclosures return `stale-reference`; delivered originals remain readable with the host's file tools. Finalization materializes verified originals at canonical snapshot paths and preserves prior state when merging guest evidence.
- Attachment means the block was included in the result; it does not prove the model inspected it or that a human reviewed it.

## Live console viewing

Acquisition never opens a viewer. `acquisition-capabilities` reads the
backend's VNC options; `acquire` with `vnc: true` checks OS availability and
requires a ready console and lease identity in the response. `console-open` is
permitted only following an explicit user request, requires `userRequested:
true`, `console_id`, `attempt_id`, `reason` and `expected`, and opens on the
declared service host, not on a remote client. `console-resolve` refreshes the
non-secret observation; `console-cancel` closes managed viewing resources and
never releases the VM. Console status `ready` is guest preflight, not launch
success; transport connection, authentication, displayed pixels and human
confirmation are separate observations that console actions never establish.
On macOS the human must choose Standard sharing of the existing console, not a
new Log In session or a High Performance display; the relay never confirms
that selection, and `server_enforced_view_only: false` with `session_binding:
viewer-selection-unverified` remain limitations after transport connects.
Failed or uncertain launches retain ownership; resolve or cancel the attempt
rather than replaying it. Console tests use mocked backends; no live viewer,
installation or platform acceptance is claimed here.

## Selected environments

Set `VM_ENVIRONMENT_FILE` to a profile that binds a loopback vm-service
endpoint, an image repository, a Tart store and separate service, image and
relay state directories together. The profile is validated before use, is
authoritative over the individual `MCP_VM_RELAY_*` variables, and an invalid
selection fails rather than falling back. Leases are bound to their backend and
store: an owned lease restored under a different environment fails before any
backend operation, and destruction is verified with the selected Tart binary
and `TART_HOME`. `docs/selected-environments.md` documents the schema. The
bundle the profile exports to subprocesses is the canonical one vm-service
defines, so its relay entries keep the `VM_RELAY_STATE_DIR` and
`VM_RELAY_URL` names and the three runtimes agree; this server reads its own
settings from the profile.

## Evidence and cleanup

Default output is `relay-evidence/<unique-task>/` under the project, with
`state/` (the guest journal, action records, receipts and snapshot PNGs),
`host/` (reasons, submissions, transfer facts, receipts, diagnostics, image
deliveries and lifecycle events), `extractions/` (declared files, including the
page captures), and `manifest.json`, `summary.json`, `trajectory.json`,
`index.html` and `OPENING.txt`. Open `index.html` directly: no server, network,
VM or external assets are needed. Diagnostic commands appear in the trajectory
as command-only steps without screenshots. `finish` verifies the package before
destroying the VM; a failed delivery removes only the derived files it created
and retains the VM for a corrected attempt. Cleanup checks the read-only host
Tart inventory (the selected one, when an environment is selected) before
claiming destruction. Leases default to 4 hours with a heartbeat; the
vm-service reaper is the final backstop for process death.

## Configuration

- `MCP_VM_RELAY_PROJECT`: the project directory (the plugin passes Claude Code's). Evidence lands under `relay-evidence/<task>/` there.
- `MCP_VM_RELAY_SESSION`: an explicit session identity. By default each server process takes a fresh random one; a stable identity lets a restarted server reconcile and reattach the enclosure of the same identity.
- `MCP_VM_RELAY_URL`: the loopback vm-service origin, default `http://localhost:6240`. Non-loopback servers, redirects and physical targets are refused.
- `MCP_VM_RELAY_STATE_DIR`: host state, otherwise `$XDG_STATE_HOME/mcp-vm-relay` or `~/.local/state/mcp-vm-relay`, one subdirectory per session.
- `MCP_VM_RELAY_REGISTRY`: an explicit task registry file; otherwise an existing compatible `~/AGENTS.md` VM table, or a private managed `registry.md` in the state directory.
- `MCP_VM_RELAY_PYTHON`: the Python 3 used for the registry lock; default `python3` on PATH.
- `VM_ENVIRONMENT_FILE`: a selected environment profile; it overrides the URL, state directory and registry above and binds the Tart store.
- Guest files go to `/var/tmp/<UTC-timestamp>-mcp-vm-relay-<task>/`, with the runtime in `receiver.mjs`, support in `support/` and work in `workspace/`.

## Development

Build relay-driver using its own instructions, then in this checkout:

```sh
npm ci
npm run setup:dev -- /absolute/path/to/built/relay-driver
npm run check                                            # build, typecheck, tests
```

Three tests need a sibling checkout beside this repository and skip with a
message when it is absent: the console fixture regeneration and the
environment parity test need `../vm-service`, and the shared catalog text
corpus needs `../pilot-images`. The JPEG and WebP presentation fixtures in
`tests/fixtures/` were encoded once from the test's spatial PNG with a codec
outside this repository and are committed, because the core carries none.

### End-to-end with headless Claude Code

```sh
npm run test:e2e
```

This runs `claude --print` with the plugin loaded from this checkout
(`--plugin-dir`), the model limited to the relay tools, and the server pointed
at a loopback stand-in for vm-service (`tests/e2e/fixture-service.ts`), which
keeps leases as records, runs the relay's own Node and transfer commands
locally, and fakes the desktop capture driver. Five cases run, each a separate
headless session: the status call (which also proves the server is pointed at
the stand-in before anything is acquired), an invalid call refused by the
contract, a full acquire, stage, exec, finish lifecycle with a verified package,
a browser lifecycle whose settle-waited page captures come home in the package,
and a lease abandoned when the session ends, which is retained with its renewal
paused rather than released. What is checked is what happened on disk and at
the service, not what the model said. The suite needs `claude` on PATH with an
account and spends a few model turns per case, so it is not part of `npm test`.

The relay-driver links are development-only. The tests run the manager, the
guest programs and the shipped server against fixture HTTP services, fake
Playwright pages and a real MCP client over stdio; no VM, desktop or user
registry is touched. Commit the regenerated `dist/` with source changes.

## Releasing

Cut a release with:

```sh
node scripts/bump.mjs X.Y.Z && git push --follow-tags
```

`scripts/bump.mjs` sets `X.Y.Z` as the version in `package.json`,
`.claude-plugin/plugin.json` and the pinned `pi-mcp.json` arg, refreshes
`package-lock.json`, rebuilds `dist/`, commits `Release vX.Y.Z` and creates the
annotated tag `vX.Y.Z`. It refuses to run against a dirty working tree or a
malformed version, and it never pushes — `git push --follow-tags` is a
separate, explicit step.

Pushing the tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which
rebuilds `vmctl`, checks the working build against a fresh one, and publishes
to npm using [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC — no `NPM_TOKEN` secret involved), then creates the matching GitHub
release.

Trusted publishing has to be configured on npmjs.com, and npm requires the
package to already exist before you can do that. The **first** publish must
therefore be done by hand (`npm publish --access public` from a maintainer's
machine) before its trusted publisher can be configured for this workflow.

## License

MIT — see [LICENSE](LICENSE).
