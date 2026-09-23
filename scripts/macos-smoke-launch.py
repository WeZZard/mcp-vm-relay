#!/usr/bin/env python3
"""Detach one acceptance process with durable stdout/stderr and identity.
No guest traffic, VM lifecycle or UI input occurs in this launcher.
"""
import json, os, pathlib, subprocess, sys, datetime
project = pathlib.Path(__file__).resolve().parent.parent
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=False)
with (root / 'host-harness.log').open('xb') as log:
    argv = [str(project / 'node_modules/.bin/tsx'), str(project / 'scripts/macos-smoke.ts'), str(root), '--run', '--review-gates']
    child = subprocess.Popen(argv, cwd=project, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
(root / 'host-process.json').write_text(json.dumps({'pid':child.pid,'argv':argv,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sessionLeader':True,'evidence':str(root/'host-harness.log')},indent=2))
print(json.dumps({'pid':child.pid,'root':str(root)}))
