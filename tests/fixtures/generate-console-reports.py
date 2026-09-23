"""Generate wire fixtures from vm-service's actual pure report methods.

No service, socket, subprocess, lease allocation, guest, or viewer is started.
Run with python3 -B tests/fixtures/generate-console-reports.py.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

# The Python backend this generator imports was replaced by the Rust port, so it
# only exists in a historical vm-service checkout. Point
# VM_SERVICE_PYTHON_BACKEND at that checkout's `bin` directory to re-run this.
override = os.environ.get('VM_SERVICE_PYTHON_BACKEND')
backend = Path(override) if override else Path(__file__).resolve().parents[3] / 'vm-service' / 'bin'
if not (backend / 'console_sessions.py').is_file():
    raise SystemExit(f'no console_sessions.py at {backend}; '
                     "set VM_SERVICE_PYTHON_BACKEND to a historical vm-service checkout's bin directory")
sys.path.insert(0, str(backend))
import console_sessions

controller = console_sessions.Manager({'enabled': True, 'linux_viewer': '/fixture/viewer', 'macos_viewer': '/fixture/Screen Sharing'})
reports = {}
for kind in ('linux', 'macos'):
    record = {'vm': 'vm-1'}
    session = {'lease_id': 'lease-1', 'environment_fingerprint': None, 'console_id': 'console-1',
               'status': 'ready', 'reason': None, 'kind': kind, 'access_expires_at': 4102444800}
    with patch.object(console_sessions.time, 'time', return_value=1790000000):
        reports[kind + '_ready'] = controller._report(record, session)
        for state in ('dispatching', 'launched', 'cancelled', 'closed', 'failed'):
            attempt = console_sessions.Attempt('watch-1')
            attempt.status = state
            attempt.transport = state == 'launched'
            attempt.authentication = 'required' if kind == 'macos' and state == 'launched' else 'unverified'
            if state in ('cancelled', 'closed', 'failed'):
                attempt.reason = state
                attempt.cleanup = 'local-children-stopped'
            reports[kind + '_' + state] = controller._report(record, session, attempt)
        session.update(status='revoked', reason='controller-shutdown')
        reports[kind + '_revoked'] = controller._report(record, session, attempt)
print(json.dumps({'source': 'vm-service/bin/console_sessions.py Manager._report and Attempt.report',
                  'source_sha256': hashlib.sha256((backend / 'console_sessions.py').read_bytes()).hexdigest(),
                  'capabilities': {'schemaVersion': 1, 'options': {'vnc': {'default': False, 'backends': controller.capabilities()}}},
                  'reports': reports}, indent=2))
