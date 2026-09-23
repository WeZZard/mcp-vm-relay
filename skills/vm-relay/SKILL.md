---
name: vm-relay
description: Run interruptive computer-use or browser-use in a fresh, disposable VM through the relay tool, with a snapshot pair per event, the saved after-image returned inline, settle-waited page captures, optional user-requested console viewing, and a verified evidence package. Use when a task must click, type or navigate in a real desktop or browser that would otherwise take over the user's display. Not for headless or non-disruptive work, which stays with local tools.
---

# The VM relay

The relay tool is `relay`. In Claude Code its full name is
`mcp__plugin_mcp-vm-relay_vm-relay__relay` (or `mcp__vm-relay__relay` when the
server is configured directly in a project's `.mcp.json`); in pi it is
`relay`. It has one required
`action`: `search`, `probe`, `acquisition-capabilities`, `acquire`,
`console-resolve`, `console-open`, `console-cancel`, `stage`, `run`, `image`,
`extract`, `finish` or `release`. There is no default action. Only `run` and
`console-open` accept (and require) a `reason`, retained as intent, never as
authorization evidence.

## When to relay

- Judge interruptiveness yourself from `action: "probe"` facts. Unknown is not idle.
- Use local tools directly for non-disruptive or headless work.
- Relay one task per enclosure. Another task needs another `acquire`.
- `probe` reports the current owned state on its own; do not rely on earlier messages after compaction.

## The enclosure, in order

1. `search` (optional): find an installed application by name in the image inventories, then choose an image yourself.
2. `probe`: read-only local and service facts. Use the image key it returns. With `scope: "guest"` on an owned VM it checks the Node and CuaDriver executables only; it does not claim capture or browser readiness.
3. `acquire`: one fresh VM for this task. Give `task` (a short slug), `image`, and `extractions`, the outputs you will bring home, declared before any work (`[]` is allowed). `vnc: true` only prepares sharing; it opens no viewer.
4. `stage`: push the runtime, optional support files and an opt-in workspace. Set `browser: {}` for a fresh persistent guest Playwright page. Staging the browser also declares the extraction `browser-captures`. Failed staging can be retried with corrected paths.
5. `run`: one admitted operation per call. Every run needs `reason`, `kind`, `step` (`id`, `title`, `expected`, `inputMode`) and `snapshots` with an explicit `afterIntervalMs` you chose for that event (for example a text echo, a dialog, or a game frame). Optional `timeoutMs` (default 120000, at most 3600000) bounds the command only. Do not hide several interactions in one script.
6. `extract` (optional): pull declared outputs early.
7. `finish`: extract declared outputs, deliver and verify the package, destroy the VM and unregister. `release` abandons the task instead, keeping whatever evidence exists. Always finish or release explicitly before you return: when the session ends, renewal only pauses and the VM is retained until its lease expires.

## Browser events

A `run` with `kind: "browser"` sends one event: `navigate`, `click`, `type`,
`press`, `read`, or `snapshot`. After each input event the guest waits for the
page to settle (load, network idle, fonts, two frames; bounded by
`settleTimeoutMs` given at stage and by the run's deadline) and returns the
wait's facts as `settled`. An event that changed the address lands a page
capture; `snapshot` captures the settled page on demand with an optional
`name`. Captures and their records go to `workspace/browser-captures` and come
home with `finish`. An event that misses its deadline has its browser context
closed; the next event uses a fresh page, and nothing is replayed.

## Inspecting what happened

- A `run` whose snapshot plan captures the after phase returns that saved image as an image block in the result. Look at it before deciding the next step. The result text starts with an `imageDelivery` line; a status other than `attached` or `not-requested` means the image did not arrive even if the command completed.
- If the image did not arrive, call `image` with the `imageId` reference the result gave, or with `{"source":"display","sessionId":…,"executionId":…,"phase":"after"}`. Never repeat the input or capture again to get an image.
- `image` with `{"source":"application","name":"browser-captures","path":"c000001-….png"}` retrieves one page capture by its declared extraction name and relative path.
- Stop exploratory input if a required image is still uninspectable after two explicit recovery calls; finish or release instead.
- An attached image is not proof that a human reviewed it.

## When something goes wrong

- A refused, uncertain or nonzero run stops that line of work but keeps the VM. Diagnose, repair with a new operation, or release. Never replay uncertain input.
- `run` with `kind: "exec"` and `diagnostic: true` records a command without screenshots, for explicitly requested diagnosis or repair, even before staging. It is not visual verification and cannot join a snapshot group.
- `stage` with `resetRecording: true` archives a damaged recording and starts a new one in the same VM after the previous operation is reconciled.
- A failed `finish` retains the VM for a corrected attempt; a failed `release` keeps ownership until destruction is verified.

## Console viewing

Only when the user explicitly asked to watch the VM: read
`acquisition-capabilities`, acquire with `vnc: true`, then `console-open` with
`console_id`, `attempt_id`, `userRequested: true`, `reason` and `expected`. It
opens on the service host, not on a remote client. `console-resolve` refreshes
the non-secret status; `console-cancel` closes the attempt and never releases
the VM. Console status `ready` is guest preflight, not a launched viewer; the
relay never confirms authentication, displayed pixels, or the human's
selection on macOS (Standard sharing of the existing console, not a new
Log In session or a High Performance display). Do not replay uncertain
launches; resolve or cancel them.

## What the results mean

- `finish` reports delivery, snapshot completeness, execution outcome and human review separately. A verified package is not a passing test, and neither is human approval.
- Text output is capped; a larger result is kept whole in a local file the result names.

Use `relay_status` to see what this session owns. Use `relay_trajectory` with a
package directory to verify it and open its viewer.
