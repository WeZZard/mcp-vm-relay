# Design conformance audit — earlier implementation

- This audit describes the implementation and design reviewed before the 2026-09-16 revision. Its results are preserved and do not establish conformance to the [new recovery and image-readiness requirements](design.md#recovery-and-image-readiness-revision-2026-09-16).
- The final independent goal audit approved the earlier scope, and both final verification gaps were closed within that authorized scope.
- New acceptance work is specified in [the implementation plan](../.plans/2026-09-16-10-51-agent-recovery-and-image-readiness.md).

Latest real-base chain: `test-evidence/real-base-chain-2026-09-13T21-04-52-286Z/`.
Actual stopped-base association → current candidate public search → sole returned-image
acquisition → immediate installation/source equality before support changes →
clone-only X11 setup → stage/run/finish passed. Parent verified all 427 original
hashes, decoded both PNGs, reran package verification (no findings), and independently
checked current service404/service/Tart/registry absence and candidate cleanup.
Parent review: `test-evidence/real-base-parent-verification.md`.
This is trusted clone-derived inventory evidence, not disk attestation; candidate
discovery uses production lifecycle service whose loaded revision is unknown.
No video or visual responsiveness claim; human review pending.

Historical rejection and corrections: The inventory-layout correction
passed independent review (agent `d4134c59-95f3-441`), but the final goal audit
identified two additional verification gaps: candidate tests associate real
observations with synthetic base files, and full backend test discovery encounters
a syntax error in `tests/e2e/test_e2e.py`. The discovery error is now fixed in
commit `c13c38a`, with live E2E explicitly opt-in. Parent tested the exact staged
snapshot: 173 discovered, 162 passed, 11 live E2E skipped. Log:
`test-evidence/backend-full-discovery-parent/vmsvc-parent-full-discovery.log`.
Actual real-base publication → candidate search → acquisition evidence remains
required. The first real-base attempt stopped before allocation because its
noncanonical macOS temporary path contained a symlink. Parent verified all 61
original evidence hashes at `test-evidence/real-base-chain-2026-09-13T20-22-14-546Z/`
and unchanged base config/NVRAM hash records. The harness now resolves the path;
the distinct attempt at `test-evidence/real-base-chain-2026-09-13T20-27-53-462Z/`
passed actual-base publication and current search, but the candidate proxy refused
acquisition before forwarding because its task-name guard omitted the manager's
`relay-` prefix. Cleanup was verified; guest inventory/stage/run/finish were not
reached. Parent fixed the guard to the actual manager format and reran four
regression tests, including the observed request and invalid-name rejection.
Dedicated agent `c64d4a41-3971-4c5` owns the next bounded VM attempt; parent owns
diagnosis and evidence review. That attempt subsequently passed as documented above. Skipped live E2E tests
are not claimed as executed. Portable observed inventories are Git-visible
and commit-ready, not yet committed (only vm-service commit was authorized).
Earlier failed attempts remain retained and do not diagnose a guest display failure.
This is not a completion certificate or production-activation approval.

## Corrected completion finding: version-controlled inventory

Portable `pilot-images/inventories/{ubuntu2404,macos26}.json` observations now
occupy the Git-visible, review-ready publication namespace. Only `local/` associations
and extracted evidence remain ignored. Closed schema-2 local associations bind the
complete portable-document SHA256 to the current base fingerprint; edits cannot
silently retain an association. Producer and backend validation, locked publication
and candidate fixtures use the split contract. Parent verified both inventory
objects exactly equal retained raw extraction JSON and their raw hashes match.
No historical observation was automatically bound to a production base.

Parent gates: 29 image fixtures, 255 relay tests/build/typecheck, eleven candidate
cases at `test-evidence/catalog-candidate-check/2026-09-13T20-07-04-750Z/`.
Logs and observation checks: `test-evidence/portable-inventory-parent-review/`.
The vm-service-only staged snapshot passed 127 unit and 35 integration tests and
was committed with explicit user authorization as `f11184e`; unrelated networking
changes remain excluded. Portable artifacts and sibling changes are not committed,
not staged, and not production-activated. Version-controlled here denotes the
implemented Git-visible artifact workflow, not an unauthorized completed commit.

## Independent correction review

Read-only reviewer `d4134c59-95f3-441` found no blocking defect within the
trusted-maintainer contract. It independently verified portable facts and all three
historical provenance hashes, reviewed invalidation/publication ordering, locking,
backend digest/fingerprint rechecks and startup-only configuration, and reran
29 image tests plus 18 backend catalog tests. It confirmed the audited backend
module is byte-identical to authorized commit `f11184e`. Git-visible artifacts are
not yet committed; production association and deployment remain separate.

## Requirement mapping

| Requirement | Implementation | Verification |
| --- | --- | --- |
| One public tool, eight closed action branches | `src/schema.ts`, `src/tool.ts` | Extension/provider-schema tests; actual Pi reload |
| Execution intent on run only | Schema, tool dispatch, manager and transport | Manager/transport/extension regressions; immutable legacy evidence coverage |
| Provision first, inventory second | pilot-images collector and maintenance entrypoints | Collector/publication fixtures and two real clone inventories |
| Exclusive maintenance and invalidation | pilot-images `host/maintenance-lock.py`, `host/lib/maintenance.zsh` | Overlapping-entrypoint and surviving-child executable fixtures |
| Read-only catalog endpoint | vm-service `bin/application_catalog.py`, Handler `/applications` | Backend tests and isolated candidate requests |
| Exact cross-language metadata policy | Four validators and shared `tests/fixtures/catalog-text.json` corpus | TypeScript plus collector/publisher/backend compatibility test |
| Deterministic matching, hard OS filtering, complete-record caps | `src/search.ts` | Matching, Unicode ordering, truncation, deduplication tests |
| Search causes no ownership recovery or mutation | `RelayManager.search` | Tool-level persisted-lease isolation and candidate ownership sentinels |
| Independent bounded diagnostic retention | `src/search-diagnostics.ts` | Closed records, unsafe entries, count/age, rollback, hash and error-message tests |
| Native prebuilt Pi Git installation | `dist/`, package metadata and install harness | Real Pi startup/reload and isolated local-mirror Git install |
| Selected-image acquire, run and verified delivery | Manager, staging and package runtime | Fresh disposable-clone stage/run/finish passed; two snapshots, exact output and cleanup independently verified |

## Review findings and resolutions

1. Maintenance originally assumed exclusivity. All four participating maintenance
   entrypoints now lock before mutation and retain ownership through publication.
   This is advisory coordination, not protection against unrelated direct Tart use.
2. Python and TypeScript differed on FEFF, surrogate handling and supplementary
   character lengths. Explicit scalar/whitespace rules and shared fixtures now align
   collector, publisher, backend and extension.
3. Diagnostic validation originally checked only identity fields. Closed schemas
   and count-consistency checks now reject incomplete/extended records. Errors use
   fixed retained text rather than arbitrary upstream messages.
4. Query normalization is shared between matching and diagnostics. Retention
   documents incoming-record priority and current-write-time expiry on clock rollback.
5. Search isolation is per tool dispatch. Existing session-start interrupted-owner
   recovery remains intentional and is documented separately; hook wiring and direct
   search isolation have separate tests.

## Established evidence

- Relay: the latest full build/typecheck gate passed 255 tests, including diagnostic,
  grouped/filtered truncation, exact UTF-8 budget and active-enclosure isolation
  regressions. Log: `test-evidence/search-implementation-check/relay-tests-255.log`.
  Actual Pi startup/reload and local-mirror Git installation were rerun successfully.
  Remote GitHub installation is not established.
- Backend: 132 unit and 35 integration tests independently rerun after the startup
  configuration fix. Existing ResourceWarnings remain.
- Image maintenance: 29 fixtures, including publication/backend compatibility and
  concurrent entrypoint locking. Fixtures are not live golden-image maintenance.
- Original real inventories:
  `test-evidence/real-installed-inventory-20260913T164629Z/`.
  Raw schemas/hashes, unchanged base metadata fingerprints and exact cleanup verified.
- Candidate discovery after Unicode fixes:
  `test-evidence/catalog-candidate-check/2026-09-13T17-18-28-157Z/`.
  Eleven cases passed; only catalog HTTP requests, unchanged ownership sentinels,
  diagnostic hashes and candidate cleanup verified. This run initialized the
  legacy discovery cache before installing process-execution guards, so its
  no-process result covers warm-cache requests, not cold-cache configuration
  loading. The subsequent startup-snapshot correction is independently verified
  by the later candidate run listed below.
- Blocked first selected-image attempt:
  `test-evidence/selected-image-lifecycle-2026-09-13T17-12-20-114Z/`.
  Probe/acquire/release and cleanup verified; no installed driver found by bounded
  discovery. Stage/run/delivery were not reached. Original failed evidence retained.

## Resolved search acceptance findings

The read-only audit identified two verification items, now resolved:

- Cold-cache shell execution is corrected: strict association initialization occurs
  after daemon-lock acquisition and before HTTP startup. Requests only read a
  detached snapshot; uninitialized/failed configuration returns 503 without retry.
  Configuration refresh requires restart; inventory/fingerprint reads remain live.
  Parent reran 132 backend unit tests and 35 integration tests. Candidate evidence
  `test-evidence/catalog-candidate-check/2026-09-13T19-05-43-914Z/` passed eleven
  cases with initializer/parser/discovery and process calls prohibited after setup.
- Grouped truncation, filtered truncation, exact byte-boundary and active in-memory
  enclosure/heartbeat isolation regressions have now been added and independently
  rerun (15 targeted tests). Tests establish the line cap and oversized-first-record
  branches are unreachable under current validated field and installation bounds.
  Log: `test-evidence/search-implementation-check/search-boundary-tests.log`.

Both search acceptance findings are corrected and independently verified.
Neither required Ubuntu GUI repair. Production publication and remote GitHub installation are separately
unverified and are not authorized by this audit.

## Preserved earlier attempts

The distinct staged-support attempt at
`test-evidence/selected-image-lifecycle-2026-09-13T17-25-23-718Z/` stopped before
stage: graphical-session discovery returned an empty list. The support binary
passed offline provenance checks but was not transferred or executed. Public
probe/acquire/release and exact cleanup were verified; parent checked all 49
manifest-listed file hashes and unchanged base fingerprints. No run, snapshots,
finished package or declared result was produced. Both failed attempts remain
preserved. This is a limitation of the additional screenshot lifecycle test, not
a demonstrated application-search failure.

A diagnostic-only fresh clone at
`test-evidence/graphical-discovery-2026-09-13T18-35-33-589Z/` initially returned no
candidates (`discovery-0.json`). After a declared ten-second wait, the user had an
active Wayland session and `xrandr --current` succeeded (`discovery-1.json` and
`discovery-2.json`). The native-X11 requirement still rejected that session. This
establishes startup timing and a session-type mismatch in the new attempt, not
the exact state of the earlier destroyed clone. Parent verified all 44 manifest
hashes, unchanged base fingerprints and cleanup. No driver was started or guest
configuration changed. Test readiness/error reporting was corrected offline: bounded repeated samples,
separate connection and session-type outcomes, and preserved diagnostics. The
standard suite now includes these regressions (246 tests passed); the updated
readiness loop has not been exercised in a new VM.
The user retained fresh selected-image run/delivery as a completion requirement.
The fresh attempt at `test-evidence/selected-image-lifecycle-2026-09-13T19-19-04-906Z/`
passed stage, one non-UI Node run and finish. Clone-only GDM configuration selected
X11; the display manager restarted once and the verified historical support driver
started with `--no-overlay`. No golden-image changes or package installation occurred.
Parent independently checked 322 original audit hashes, decoded both PNGs, verified
output hash, cleanup evidence and identical base fingerprints (`parent-verification.json`).
Delivery and execution passed; snapshots are complete; human review remains pending.
No video was recorded and no browser operation or visual responsiveness was tested.
Support binary upstream authenticity remains unverified.

Non-UI execution does not establish browser behavior, video completeness or human
approval.

Only the vm-service catalog commit `f11184e` was subsequently authorized and made.
No pushes, production deployment, live inventory association publication or
golden-image maintenance were performed. Unrelated vm-service
control-only networking changes and harness state are not part of this work.
