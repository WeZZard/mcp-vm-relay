# relay_run: forwarding MCP tool calls into the VM

`relay_run` replaces `relay_cua` and `relay_browser`. The model sends the
tool calls it already knows for cua-driver, Playwright MCP or Chrome DevTools
MCP. The relay carries each call into the VM and records evidence around it.
`relay_tools` returns a target's real `tools/list`.

## The path of one call

```
relay_run {target, tool, args}
  host: stage the target if needed, start the guest MCP host if needed,
        fetch the target's tools/list once, check args against the tool's schema
  host -> guest receiver (one process per request, as for every run)
    admission journal, before-snapshot
    dispatch: node mcp-host.mjs call <stateDir> <target> <tool> <argsJson> <timeoutMs> <startMs>
      -> guest MCP host over a Unix socket
        -> the target server's own tools/call, through an MCP SDK Client
    wait afterIntervalMs, after-snapshot, execution-completion journal entry
  host: pass the tool's text and images through, attach the after-snapshot
```

The MCP client runs inside the guest, on the receiver's path. The receiver
journals the exact `call` argv, which holds the target, the tool and the
arguments. Nothing goes from the host to the guest around the receiver.

## The guest MCP host

The receiver is spawned once per request. Playwright MCP and Chrome DevTools
MCP keep their browser inside their own process, so a small detached process
(`dist/mcp-host.mjs`) holds the sessions. It follows the pattern of the
persistent guest browser it replaces:

- The relay pushes it hash-checked and starts it once, with `mcp-host.mjs
  start <config>`, before the first `relay_run` or `relay_tools`. Starting the
  host starts no server.
- It starts each target's server on first use, through the SDK's
  `StdioClientTransport`, and holds one SDK `Client` per target. The server
  inherits the guest session's environment (`DISPLAY`, `XAUTHORITY`, `HOME`),
  so the browser opens headed on the VM's display.
- It serves the per-request `call` client over a Unix socket in
  `<guestRoot>/mcp`. That directory is mode 0700 and the socket is mode 0600.
  The socket is addressed relative to that directory, which keeps it under
  the 104-byte `sun_path` limit whatever the lease root's length.
- It takes one call at a time. A second call while one runs is not sent.
- `relay_finish` and `relay_release` stop it, and with it every server, before
  outputs are extracted. A corrected `nodePath`, `cuaDriver` or
  `browserExecutable` on `relay_stage` also stops it, so the next call starts
  the servers with the new paths. Destroying the VM is the final cleanup.

## Targets, launch commands and pinned versions

All pins are in `src/targets.ts`.

| Target | Server | Launch (argv, cwd = guest workspace) |
|---|---|---|
| `cua` | the image's own `cua-driver` | `<cuaDriver> mcp` |
| `playwright` | `@playwright/mcp` 0.0.82, with `playwright` and `playwright-core` 1.64.0-alpha-1789764292000 | `<node> <packages>/node_modules/@playwright/mcp/cli.js --isolated --output-dir <workspace>/relay-run/playwright/files [--executable-path <browserExecutable>]` |
| `chrome-devtools` | `chrome-devtools-mcp` 1.10.1 | `<node> <packages>/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js --isolated --no-usage-statistics --no-performance-crux --no-page-id-routing --workspace <workspace> [--executablePath <browserExecutable>]` |

- **cua.** `cua-driver mcp` is the MCP stdio proxy to the Cua Driver daemon.
  The overlay flags belong to `serve`, not to `mcp`. On Linux the daemon must
  already run as `cua-driver serve --no-overlay`. That is the same
  precondition `cua-driver call` had, and the proxy connects to that daemon.
  On macOS the proxy starts the CuaDriver app's daemon if none is running.
- **Browsers.** Both servers are headed by default, and the relay never
  passes `--headless`. Both use `--isolated`, so each start is a fresh browser
  profile. Without `browserExecutable` they use installed Google Chrome, the
  default channel of each server. Guests without Chrome, such as Linux arm64,
  need `browserExecutable` set to a Chromium path.
- **Chrome DevTools MCP page routing.** Page-ID routing is meant for several
  agents that share one browser, and it makes `pageId` required on
  page-scoped tools. It is turned off, because one enclosure has one agent.
  Tools such as `navigate_page` keep their usual shape and act on the
  selected page.

### How the packages reach the guest: staging, not npx

On the first use of a browser target, the host does three things:

1. It downloads each pinned npm tarball from the registry, or from the mirror
   in `MCP_VM_RELAY_NPM_REGISTRY`.
2. It checks each tarball against its pinned `sha512` integrity, which is the
   value npm publishes, and caches it under the relay state root.
3. It pushes each tarball with the same hash-checked transfer that
   `relay_stage` uses. `mcp-host.mjs install` then checks each tarball's
   SHA-256 again and unpacks it into one flat `node_modules`.

A tarball that does not match its pin is never cached and never staged. This
approach was chosen over `npx` at first use for three reasons:

- The guest needs no network and no npm.
- Every byte the guest runs is pinned, including the transitive
  `playwright-core`, which `npx` would resolve at run time.
- The existing stage transfer already gives hash-checked delivery.

The staged closure is about 6.7 MB, made of four pure-JavaScript tarballs with
no install scripts. The host needs registry access once per version.

## Validation

The host checks `args` before anything reaches the guest receiver. It uses
Ajv, which the MCP SDK already depends on and which is bundled. The Ajv
dialect follows the schema's `$schema`: Playwright MCP emits 2020-12, and most
other servers emit draft-07. Formats are checked, and unknown keywords are
ignored. An unknown tool or a mismatch returns a refusal with the errors and
the tool's `inputSchema`, and nothing is sent. The guest MCP host checks the
same schema again right before `tools/call`, as a second line of defence.

The host fetches the list once per target, through `mcp-host.mjs tools`, and
keeps a copy in the host evidence under `host/mcp-tools/`. Fetching the list
starts the target's server outside a recorded step. Starting a server sends
no tool call. Neither browser server opens a browser before its first tool
call.

## Outcome mapping

| What happened | Receiver outcome | `relayOutcome` | Result |
|---|---|---|---|
| The host refused (unknown tool, schema mismatch, arguments over 64 KiB) | none: nothing was sent | `refused` | error; no snapshot |
| The guest never sent it: no host, host busy, server failed to start, server had already exited, guest schema check | `refused` | `refused` | error; snapshots kept |
| cua-driver's structured `desktop_escalation_required` | `refused` | `refused` | error |
| The server answered | `completed`, exit 0 | `completed` | success |
| The server answered `isError: true`, or with a JSON-RPC error | `completed`, exit 3 | `completed-with-tool-error` | error |
| No answer within `timeoutMs`, the server died mid-call, or the answer was unreadable | `uncertain` | `uncertain` | error; the server is stopped |

- Every error result keeps the VM. A failure after the call reached the
  receiver also records `lastError`; a host-side refusal sent nothing and only
  leaves a `relay-run-refused` host event.
- Nothing is replayed. A server that died is started fresh on the next call,
  and its lost session state is reported rather than recreated.
- The after-snapshot and the separate `imageDelivery` identity work as they do
  for every run.
- `timeoutMs` bounds the tool call itself. The receiver's dispatch bound adds
  60 s for a first-use server start and 15 s of margin.

## Result mapping

The call's result directory is `workspace/relay-run/<target>/<stamp>-<seq>-<tool>/`.
It holds `result.json` (the full result) and each image or binary block as its
own file. The `call` client prints a bounded summary of at most 48 KiB, with
text capped at 32 KiB and base64 kept out. That keeps the summary well below
the receiver's 64 KiB output limit.

The MCP content of a relay result comes in this order:

1. The relay's text: the execution identity, the outcome, the derived step,
   the tool image deliveries and `resultFile`.
2. The tool's own text blocks, within the relay's 50 KiB and 2000-line bound,
   with a truncation note that points at the result file.
3. The tool's images: up to four, delivered as application images of the
   `relay-run` extraction under the usual image bounds, and retrievable later
   with `relay_image`.
4. The relay's after-snapshot.

## Default waits

The default is the wait from the end of the call to the after-snapshot.

| Target | Default `afterIntervalMs` | Why |
|---|---|---|
| `playwright`, `chrome-devtools` | 300 | Both servers wait for the page to settle before they answer. This wait covers the display catching up. |
| `cua` | 500 | cua-driver returns when input is dispatched, so native animations and dialogs need longer. |
| `relay_exec`, `relay_script`, `relay_code` | 500 | Same as `cua`. A command's visual effect is unknown. |

## Not yet proven without a live VM

The tests use SDK fixture servers, a fake capture driver and a loopback
stand-in for vm-service. The following checks need one live run:

1. On `ubuntu2404`, stage with the image's `cua-driver` and start `cua-driver
   serve --no-overlay`. Then call `relay_tools {target:"cua"}` and one
   `relay_run` `cua` call, such as `get_screen_size`. Confirm that `cua-driver
   mcp` reaches the running daemon.
2. On `macos26`, make the same `cua` calls through `/Applications/CuaDriver.app/.../cua-driver mcp`.
   Confirm that TCC permissions carry over to the proxy's daemon, and that a
   `click` lands and shows in the after-snapshot.
3. On both images, run `relay_run` `playwright` `browser_navigate` and then
   `browser_snapshot`. Confirm three things: the host downloads the pinned
   tarballs, the guest unpacks them, Chromium opens headed on the VM display,
   and the after-snapshot shows the page. Set `browserExecutable` where
   Google Chrome is absent, such as Linux arm64.
4. Make the same check with `chrome-devtools` `navigate_page` and
   `take_screenshot`, including the inline tool image.
5. Call `relay_finish` and confirm that the `relay-run` extraction and the
   server logs are in the package, and that no MCP host or browser process
   survives the host stop.
