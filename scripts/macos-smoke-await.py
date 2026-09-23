#!/usr/bin/env python3
"""Wait for a specific application-review barrier or terminal cleanup.
This is local process coordination, not VM/UI polling or readiness inference.
"""
import pathlib,json,sys,time
root=pathlib.Path(sys.argv[1]); wanted=sys.argv[2]
deadline=time.monotonic()+900
while time.monotonic()<deadline:
    if (root/'cleanup.json').exists():
        print(json.dumps({'terminal':True,'cleanup':json.loads((root/'cleanup.json').read_text()),'error':json.loads((root/'error.json').read_text()) if (root/'error.json').exists() else None})); break
    if (root/'gate.json').exists():
        state=json.loads((root/'gate.json').read_text())
        if state['name']==wanted:
            print(json.dumps(state));break
    time.sleep(1)
else:
    raise SystemExit('Local harness barrier not reached within bound: '+wanted)
