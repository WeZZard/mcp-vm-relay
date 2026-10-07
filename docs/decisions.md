# Decisions

Decisions are the person's own. A decision marked "on the agent's recommendation" was proposed by the agent and accepted by the person.

## Screenshot delivery

The design is [screenshot-delivery.md §10](screenshot-delivery.md#10-background-download-of-after-images).

| ID | Decision | Owner |
|---|---|---|
| DC-1 | The guest captures the screenshot at once. The host downloads it in the background. Returning the screenshot's path in the `relay_run` result does not depend on the download. | The person (2026-10-02). |
| DC-2 | `relay_run` always returns without waiting for its screenshot download. There is no option to wait. | The person (2026-10-02). |
| DC-3 | The background downloads block `relay_finish` and `relay_release`: both wait until every queued download has ended. | The person (2026-10-02). |
| DC-4 | One download worker per enclosure, with a bound of 64 queued downloads. Tune both from the verification run. | The person, on the agent's recommendation (2026-10-02). |
| DC-5 | Retry backoff of 1 s, then 3 s, within a download's three attempts. | The person, on the agent's recommendation (2026-10-02). |
| DC-6 | `relay_finish` reuses the screenshots the host already holds. | The person, on the agent's recommendation (2026-10-02). |
| DC-7 | The worker pauses after a transient failure. When a lifecycle operation lifts the pause and the next download fails again, the operation cancels the rest of the queue and pulls those originals itself. | The person, on the agent's recommendation (2026-10-02). |

## Held input

The design is [relay-run.md, Held input](relay-run.md#held-input).

| ID | Decision | Owner |
|---|---|---|
| DC-8 | `relay_run` can deliver a call and hold it in the guest until `relay_gate` releases it, so a caller's check runs while the call travels. A call not released is refused with nothing sent. The hold sits before the before-snapshot; the decision is a file in the guest, and the first writer wins; the limit defaults to 60 s, at most 300 s; a withheld call is not a VM failure. | The person (2026-10-04), for pi-secretary's guardian (its decision PS-D45). The placement, the file signal, the limits and the failure rule are the agent's defaults. |
