# pi-vm-relay — Design Overview

*Historical: this document was inherited from pi-vm-relay, which is retired.
mcp-vm-relay replaces it and carries this design forward; installation
wording below has been updated where it named pi-vm-relay's own install
path, and is otherwise left as written.*

| Item | Value |
|---|---|
| Document type | Design entry point and status summary |
| Product | One Pi tool for disposable-VM discovery and recorded execution |
| Status | The user-approved screenshot-delivery revision is implemented and automated-tested in this worktree. Deployment and live acceptance are not claimed. |
| Evidence | [Implementation verification](verification.md); human review remains separately tracked |

## Document map

UX concerns, engineering contracts and implementation evidence are documented
separately, using UX-specification and engineering-RFC sections.

| Document | What it owns |
|---|---|
| [UX design](ux-design.md) | Problem, users/jobs, goals, user flows, interaction examples, empty/partial/failure states, presentation and UX acceptance |
| [Technical design](technical-design.md) | Architecture, API/data contracts, algorithms, lifecycle, evidence, security, compatibility, rollout and engineering acceptance |
| [Console contract](console.md) | Implemented guest-sharing actions, nested observations, ownership and recovery. |
| [Selected environments](selected-environments.md) | The agreed isolated-store configuration, dependency injection, and backend ownership contract. |
| [Screenshot delivery](screenshot-delivery.md) | The implemented worktree contract for typed command-result images, owner-scoped recovery, application-image authorization, and presentation failures, with explicit acceptance limits. |
| [Verification](verification.md) | Measured implementation evidence, historical gates and environment-specific acceptance—not unimplemented design promises |
| [README](../README.md) | Installation and operational instructions, with worktree-only features identified separately from deployment. |

UX examples illustrate the interaction. The technical document is authoritative
for field semantics, validation and runtime invariants. These are design contracts,
not assertions that every described capability is already shipped.

## Product summary

The operating agent judges whether desktop/browser work would interrupt the
human. Non-interruptive work uses local tools outside this extension. Interruptive
work runs in a dedicated VM with recorded actions, declared outputs and accountable
cleanup. Applications compose VM-use subagents by prompt; pi-vm-relay does not
spawn them or record video itself.

The planned discovery flow finds installed applications by name and lets the agent
choose the image and operating system. Provision the image first, then extract
its installed-application inventory for search. Operating instructions and image
acceptance remain separate from that inventory.

## Recovery and image-readiness revision (2026-09-16)

- This revision records the owner's decisions after the `progressively-homepage` investigation. It describes target behavior, not a completed implementation.
- The application inventory belongs at `pilot-images/images/<image>/applications.json`. Rename the existing configuration tree from `lines/` to `images/` while keeping image IDs and Tart base-VM names unchanged.
- Host-specific associations use a shared configured local state directory outside the repository, defaulting to `$XDG_STATE_HOME/pilot-images` or `~/.local/state/pilot-images`.
- Each application deliberately added by provisioning uses a shared baseline test plan for basic availability and startup. Unchanged OS software may remain in the catalog but is not automatically tested; our image-configuration checks remain required. Special applications add separate extensions under `applications/<application-id>/` instead of changing the shared baseline for all applications. Image acceptance executes the applicable plans on a fresh clone through vm-service's actual execution environment.
- An ordinary tool failure must not destroy the VM or prevent the agent from investigating, repairing the environment, and issuing another operation. Uncertain operations are reported and are never automatically replayed.
- Use the existing state machine and persisted ownership records so lifecycle state does not depend on conversation history. Context compaction does not reset the VM state or prevent agent recovery.
- Application matching stays in the extension. This revision does not introduce pagination or change the existing search response contract.
- The `run` action accepts an optional execution `timeoutMs`, with a 120,000 ms default and a 3,600,000 ms maximum. The execution timeout is independent of the screenshot delay.
- Successful `finish` and explicit `release` end the VM lifecycle. Session completion, shutdown, or replacement retains the VM; inactive sessions stop renewing it and report the confirmed expiration time. Active work renews the lease, and reload or resume reconciles persisted ownership without replay.
- Host observations and guest readiness checks are separate concerns. The host idle-time query uses `ioreg -r -c IOHIDSystem`.
- An isolated environment selects the backend, image repository, Tart store, and mutable state directories together. A worktree is optional, but it does not replace a separate Tart store. Operations and destruction verification use the same selected configuration.
- Failure responses must identify the command outcome, available diagnostic output, evidence location, and actual VM lifecycle state without implying that failure means release.

### Documents and implementation status

- [Technical design Sections 3.5–3.6](technical-design.md#35-execution-timeout) define timeout and probe requirements.
- [Technical design Sections 4.1–4.1.1](technical-design.md#41-data-ownership-and-inventory-extraction) define inventory ownership and application test plans.
- [Technical design Sections 5–5.2](technical-design.md#5-lease-lifecycle-persistence-and-recovery) define recovery and cleanup requirements.
- [The implementation plan](../.plans/2026-09-16-10-51-agent-recovery-and-image-readiness.md) tracks work, dependencies, tests, and unresolved decisions.
- The working tree implements relay recovery, configurable timeouts, scoped probes, catalog migration, shared application baselines, pinned Ubuntu capture provisioning, and fresh-work-clone promotion checks. Automated work-image and fresh-clone acceptance, plus real relay failure/recovery sequences, have passed on both OS families. Production activation and manual review have not occurred. See [verification.md](verification.md) for results and limitations.

## Guest-sharing console consumer implementation

- The relay source now implements optional VNC acquisition, read-only acquisition capability discovery, and explicit owned-console resolve/open/cancel actions. [The console contract](console.md) specifies the implemented fields and backend expectations.
- This implementation uses service-owned guest sharing with unmodified Tart. It adds no private Tart protocol or client-side viewer launcher.
- Component tests establish the implemented contract, not live viewing, authentication, correct pixels, or human confirmation. [Verification](verification.md#console-rollout-status) records deployment and configuration observations separately.

## Live VM viewing requirements (2026-09-20)

- Implementation was authorized on 2026-09-20. The backend contract and relay consumer now exist; the original missing-API finding in [the historical investigation](live-view-investigation.md) no longer describes current source. Live acceptance and viewer interruption require separate authorization.
- The user must be able to watch the same leased guest desktop that the agent operates and relay captures. Retained screenshots, evidence review pages, and recordings do not substitute for live viewing.
- Relay must separate read-only discovery of the owned VM's viewing capability from an explicitly requested operation that opens a standard viewer in the service host's logged-in graphical session, not on an arbitrary remote client.
- Discovery must use authoritative lease, backend, and selected-environment identity. Consumers must not guess VNC endpoints or bypass relay through vm-service, SSH, or Tart.
- Target resolution, viewer launch, connection establishment, and correct-display confirmation are separate outcomes. A successful local launch does not prove that the correct guest display is visible.
- Viewing must preserve ownership, lease renewal, and verified destruction. Credentials must not enter model-visible output or evidence, and any temporary connection resources require explicit cleanup.
- Required viewing must be established before guest application work. A live human view does not replace usable relay snapshots for the agent.
- The black-snapshot disagreement reported in the handoff remains a separate investigation. Live viewing must not be claimed to fix it without evidence.
- [UX design Section 6.8](ux-design.md#68-live-viewing-of-the-owned-vm) defines the supported flow and failure experience.
- [Technical design Section 3.8](technical-design.md#38-live-viewing-of-the-owned-vm) defines ownership, security, lifecycle, and pending live acceptance requirements.
- `acquisition-capabilities` discovers startup configuration without allocation. `acquire.vnc: true` opts into guest preparation; it never opens a viewer. `console-resolve`, `console-open`, and `console-cancel` operate on the owned lease and nested viewing attempt.
- Linux uses same-session X11 sharing with server-enforced view-only access. macOS uses Apple's Screen Sharing and human authentication; the human must choose Standard sharing of the existing console. It cannot claim server-enforced view-only access or automatically verified display selection.
- The [source handoff](../.handoff/2026-09-20-live-vm-viewer-for-human-observation.md) retains the original request and evidence locations. Component tests do not satisfy live acceptance, and material design changes still require review.

## Screenshot-delivery revision (2026-09-21)

- The user approved runtime implementation after the original documentation proposal. The [screenshot-delivery contract](screenshot-delivery.md) now describes the screenshot-delivery tool changes, including `image`. The installed plugin and consumer integrations were not modified; deployment and live acceptance remain separate work.
- Recorded operations return their saved after-image as typed final tool content when the explicit snapshot plan captures that phase and delivery succeeds. Text-group members without an after-capture do not receive an invented image. Execution and image-delivery outcomes remain independent, including through Pi's native error-result hook.
- The implemented `image` action has closed display, declared-application, and reference selectors. Recovery retrieves the same authorized original without input, capture, consumer-directory export, or acquisition. Immutable references bind owner, enclosure, backend, and original identity; retained recording lineages permit verified local recovery without a reachable guest.
- Originals are bounded to 64 MiB, 40,000,000 decoded pixels, and 32,768 pixels per dimension. Previews use Pi's public `resizeImage` helper with 2,000 × 2,000 pixel and 4 MiB base64-data limits. JSON/journal metadata is bounded to 4 MiB per file. Each delivery has a total 90-second deadline and three shared byte-transfer attempts, including metadata transfers.
- Relay display evidence and application screenshots retain separate identities and storage. Finalization merges verified originals at canonical snapshot paths without overwriting conflicts. UUID full-workspace destinations preserve earlier attempts.
- Real Pi SDK 0.85.1 tests cover final text/image results, error flags, persistence, and image blocking. Four provider adapters are tested offline for normal/error serialization and non-vision behavior. The exact affected gateway, live model inspection, and actual VM acceptance remain unverified.
- The pre-merge screenshot-delivery `npm test` run contains 438 tests: 435 passed, two failed, and one was skipped. The failures depend on missing historical `test-evidence/ubuntu-20260912-2127` and sibling `pilot-images/inventory/collect.py` fixtures. Build, typecheck, RPC smoke, and clean-install checks passed; not all gates passed.
- The [investigation plan](../.plans/2026-09-21-screenshot-delivery.md) preserves the original diagnosis and proposal rather than retroactively describing them as implemented. The [verification report](verification.md#screenshot-delivery-investigation-2026-09-21) separates automated evidence from pending agentic inspection and human review.

## Decision summary

| Decision | Target behavior |
|---|---|
| One tool | `relay` has thirteen explicit actions: `search`, `probe`, `acquire`, `stage`, `run`, `image`, `extract`, `finish`, `release`, `acquisition-capabilities`, `console-resolve`, `console-open`, and `console-cancel`. No legacy tool aliases are added. |
| Discovery | `search` with required nonblank `name` and optional hard `os` filter (`linux` / `macos`) |
| Results | Applications grouped with image installations, versions, OS and architecture |
| Truncation | Bounded complete records and an accurate `truncated` flag retained as diagnostic evidence |
| Minimal scope | No categories, fuzzy/semantic search, caller limit, cached pagination or continuation token |
| Reasons | Required for `run` and explicit user-requested `console-open`; other actions reject `reason`. Console intent is not screenshot or authorization evidence. |
| Annotation vs identity | Natural-language reason describes intent; structured IDs govern identity/control |
| Inventory | Extract installed applications after provisioning and publish them under `images/<image>/applications.json`. |
| Image acceptance | Test explicitly provisioned software using shared baselines and isolated extensions; retain required image-configuration checks on fresh clones. |
| Error recovery | Preserve the VM and allow agent-directed investigation and repair after tool failures. |
| Timeout | Make `run.timeoutMs` configurable and separate from the screenshot delay. |
| Cleanup | Use explicit completion or release and lease expiration without silently defeating agent recovery. |
| Probe scope | Distinguish host observations from guest readiness. |
| Installation | npm (`npm install -g @wezzard/mcp-vm-relay` or `npx @wezzard/mcp-vm-relay`), the Claude Code plugin, or `pi install npm:@wezzard/mcp-vm-relay` via pi-mcp-adapter; pi-vm-relay's git-based `pi install` is retired, and there is no tarball distribution |

## Design boundaries

The UX and technical specifications cover discovery, the dedicated VM lifecycle,
recorded execution, evidence, cleanup and native Pi installation.

- Inventory publication and catalog reading must agree on image identity and file locations.
- The [implementation plan](../.plans/2026-09-16-10-51-agent-recovery-and-image-readiness.md) owns unresolved decisions and implementation sequencing.

The UX and technical documents contain Mermaid diagrams for user journey,
component ownership, discovery, lease lifecycle and recorded execution. They are
conceptual diagrams, not assertions of internal state enum names or new backend
endpoints.

## Verification boundary

Use [verification.md](verification.md) for implementation status, automated gates
and environment-dependent evidence. A design document or historical trajectory
is not proof that a capability is implemented. Repository privacy and public
licensing remain owner decisions.
