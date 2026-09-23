---
name: relay-status
description: Show this session's owned VM lease with its renewal, console and staging state, the evidence path, the VM service and the selected environment.
disable-model-invocation: true
---

Call the `relay_status` tool of the `vm-relay` server and report its answer to
the user as it is. `{"active": false}` means this session owns no VM; the
answer still names the project, the VM service origin and the selected
environment, if any. When a lease is owned, the answer includes its renewal
state and last confirmed expiration, the console observation, the last error
and the evidence path. Do not act on the lease from here; `finish` and
`release` are relay actions.
