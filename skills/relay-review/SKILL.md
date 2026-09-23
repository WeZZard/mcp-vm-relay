---
name: relay-review
description: "Verify a delivered relay evidence package and open its viewer in the local browser. Usage: /relay-review <package directory>"
disable-model-invocation: true
---

Call the `relay_review` tool of the `vm-relay` server with `directory` set to
`$ARGUMENTS`. If the argument is empty, ask for the package directory instead
of guessing one. Report the tool's answer. Opening the viewer does not mean the
work was approved: human review remains pending until the user says otherwise.
