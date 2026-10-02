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
