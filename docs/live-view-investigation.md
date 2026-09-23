# Live VM viewing: Historical implementation investigation

## Superseded status

- This report preserves the original investigation against the revisions listed below. Its missing backend API, unresolved public interface, and implementation-blocked findings are historical, not current guidance.
- Relay `6e555c0` and vm-service `7aea50f` implement guest-console sharing with unmodified Tart. [The console contract](console.md), [technical design](technical-design.md#38-live-viewing-of-the-owned-vm), and [verification](verification.md#console-rollout-status) supersede those status conclusions.
- The original findings, failed aggregate gate, and capture disagreement below are preserved without being reclassified as successful acceptance. Current component results do not prove live viewing, repair black snapshots, or supply human confirmation.

## Original investigation status

- The user authorized implementation of the live-view plan on 2026-09-20. This supersedes the earlier implementation-approval gate, but does not authorize a local viewer interruption, live VM acceptance, production activation, publication, or golden-image changes.
- Phase 1 found a missing backend dependency. No secure lease-bound console discovery or opening API exists in the inspected vm-service source. The plan requires that capability to be delivered by its owner before dependent relay implementation.
- No feature code or public viewer invocation was added. No viewer opened, VM was acquired, production service was contacted, or human visibility confirmation was obtained.
- The backend requirement was handed off at `../vm-service/.handoff/2026-09-20-owned-live-console-contract.md`. The backend transport and credential mechanism require review before implementation proceeds.

## Investigation evidence

| Component | Inspected version or source | Finding |
|---|---|---|
| Relay | `e077367427e6a46a39039434725881c21a979e3e`, with the user's existing design edits. | The current `VmBackend`, schema, and manager have no live-view contract. |
| vm-service | `478ba861b67e789fdc1364790326a6775b7ff1e8`. | `_provision` starts Tart with `--no-graphics`; HTTP routes contain no console operation. |
| Backend capability route | `bin/vm-service` and `bin/control_only.py`. | `/capabilities` describes control-only networking, not viewing. |
| Installed Tart | `tart --version`, `tart --help`, and `tart run --help`. | Version `2.32.1` provides VNC boot options, not an attach command. |
| Upstream Tart | Tag `2.32.1`, `Sources/tart/Commands/Run.swift`. | An already-running VM is rejected; VNC is selected when constructing the VM. Closing the built-in VM window signals termination or suspension. |
| Upstream experimental VNC | `Sources/tart/VNC/FullFledgedVNC.swift`. | It creates a password-protected private-framework server and returns a password-bearing URL that `Run.swift` prints in headless mode. |
| Upstream guest sharing | `Sources/tart/VNC/ScreenSharingVNC.swift`. | It resolves an address but does not establish the guest's sharing service, authentication, or desktop identity. |
| Upstream control socket | `Sources/tart/ControlSocket.swift`. | It proxies guest commands and does not expose console attachment. |
| Local viewer inventory | Read-only filesystem inspection. | `/System/Applications/Utilities/Screen Sharing.app` exists; its presence is not connection evidence. |

- Upstream files were retrieved through HTTPS from `https://raw.githubusercontent.com/cirruslabs/tart/2.32.1/`. Copies are retained under `test-evidence/live-view-investigation/relay-investigation-*.swift`.
- No runtime logs containing possible credentials were read. The credential disclosure finding comes from upstream source, not an exposed real password.
- Tart returning a loopback URL does not prove its server's actual listening-interface restrictions. No such security claim is made.
- The backend's environment fingerprint is configuration identity, not caller authentication. Its existing HTTP trust model must not be silently represented as a new authorization mechanism.

## Historical decisions and implementation boundary

| Decision | Current result |
|---|---|
| Backend capability | The inspected backend does not provide the required API. A backend-owned implementation is required. |
| Public discovery surface | Selection is deferred until an authoritative backend contract exists. Extending probe remains an option, not an implemented invocation. |
| Explicit opening surface | Selection is deferred. No additional tool, action, or command has been registered. |
| Secure viewer integration | Stock experimental VNC is insufficient because its URL enters logs. A supported private handoff or a verified guest-sharing mechanism must be reviewed. |
| Readiness evidence | Resolution, launch, connection, rendered-display confirmation, and human review remain separate. No later stage is inferred from launch success. |
| Temporary resources | The backend must own revocation through release, expiry, and process loss. The relation between viewer authorization expiry and the backend's destruction grace period is unresolved. |
| Repeated and uncertain requests | No uncertain launch may be automatically replayed. An attempt identity and reconciliation contract must be supplied by the backend owner. |
| Required-viewing enforcement | Consumer stop-before-work guidance remains required. Persisted runtime enforcement versus consumer-only enforcement is not yet selected. |
| Display identity | The virtual console and capture path must be compared on an authorized disposable lease. Historical page captures do not establish desktop identity. |

- Enabling VNC at every boot, restarting a retained lease, scraping a credential-bearing Tart log, or inventing a guest VNC endpoint would materially change or violate the approved design. None was implemented.
- The recommended next decision is to review the backend console mechanism, including boot-time prerequisites, secret handoff, actual display identity, and access expiry. This is not another request for generic relay implementation approval.
- No Pi extension API was changed or selected. Pi extension documentation review remains a prerequisite when the delivered backend contract permits selecting and implementing the public integration.
- Phases 2–4 and feature-specific Phase 5 tests remain blocked. A mock-only viewer implementation would not satisfy the backend delivery dependency and is not presented as progress toward a working feature.

## Historical capture disagreement

- Both original image files named by the source handoff were read without modification.
- The relay desktop image at `../AnyDict/relay-evidence/relay-discord-synthetic-visual-33743b2d/state/snapshots/session-0mu9edxx6270r45qb/a000035-20260920T055211.018Z-after-execution-0mu9efslfo8jhq5py.png` appears black.
- The browser-page image at `../AnyDict/relay-evidence/relay-discord-synthetic-visual-33743b2d/extractions/discord-visual-output/5d09dd26-9e54-4d10-8e39-dd42fab34b0b/case-a/session/shots/0000-initial.png` shows the rendered synthetic community fixture.
- This verifies the reported disagreement in retained artifacts, not its root cause. The two capture paths do not prove what a human would see in the VM console.
- The disagreement remains a separate visual-verification blocker. No Discord collection, successful trajectory, or capture repair is claimed.

## Automated checks

- The host used Node.js `v22.19.0` and npm `10.9.3`.
- `npm run check` completed its build and typecheck, then failed the aggregate test run. The test runner reported 293 tests, with 292 passing and one failing. These counts are the runner's test totals, not feature coverage.
- The failure was `interrupted start terminates its detached child instead of orphaning a browser` in `tests/browser.test.ts`. Its fixture event reader threw `Unexpected end of JSON input` at line 62. No viewer implementation was present during this run, and no unrelated fixture code was changed.
- `node --import tsx --test tests/browser.test.ts` passed on a focused rerun. That rerun does not erase the failed aggregate gate or establish its cause.
- `npm run test:install` passed. It exercised actual Pi installation from an isolated local Git mirror, registered schema/commands, and reload without models or VMs. It did not test remote GitHub access or a live console.
- The build produced no changes to tracked `dist/` files. No distribution update is warranted for this documentation-only blocked implementation.
- Logs are retained in `test-evidence/live-view-investigation/check.log`, `browser-rerun.log`, and `install.log`. The installation harness also refreshed its ignored `test-evidence/git-install-smoke/` records.
- The evidence directory is ignored by Git. These local records are not committed delivery artifacts.

## Acceptance and delivery gates at the time of investigation

- The backend contract, secure implementation, public relay integration, and feature-specific ownership/security tests remain pending.
- The full aggregate automated gate has a recorded failure and must pass before feature acceptance is claimed.
- Isolated live acceptance and permission to interrupt the local desktop remain pending. Actual human visibility confirmation remains pending.
- No test leases or temporary access resources were created by this investigation, so there is no live cleanup receipt to report.
- Production activation, package publication, and image changes remain separate decisions. No commit or push was performed.
