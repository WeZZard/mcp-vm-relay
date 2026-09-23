---
name: relay-trajectory
description: "Verify a delivered relay evidence package (every artifact, hash and reference) and open its trajectory viewer in the local browser; human review remains pending. Usage: /relay-trajectory <package directory>"
disable-model-invocation: true
---

Call the `relay_trajectory` tool of the `vm-relay` server with `directory` set
to `$ARGUMENTS`. If the argument is empty, ask for the package directory
instead of guessing one. Report the tool's answer. Opening the viewer does not
mean the work was approved: human review remains pending until the user says
otherwise.
