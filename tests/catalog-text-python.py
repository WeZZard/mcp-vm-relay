"""Cross-repo compatibility adapter: no production cross-repository imports."""
import importlib.util
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
# vm-service's Python catalog was ported to Rust and is tested in vm-service.
paths = [root / 'pilot-images/inventory/collect.py',
         root / 'pilot-images/host/inventory.py']
modules = []
for i, path in enumerate(paths):
    spec = importlib.util.spec_from_file_location('validator_' + str(i), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    modules.append(module)

cases = json.load(sys.stdin)
count = 0
for case in cases:
    for module in modules:
        try:
            if module is modules[0]:
                module.text(case['text'], case['limit'], 'fixture')
            elif module is modules[1]:
                module.text(case['text'], case['limit'])
            else:
                module._text(case['text'], case['limit'])
            valid = True
        except ValueError:
            valid = False
        assert valid == case['valid'], (module.__file__, case['name'], case['limit'])
        count += 1
# Provenance keeps its distinct control allowance in the publication validator.
provenance_checks = 0
for value, valid in [(' \t\n', True), ('\ufeff', True), ('a\x00', False), ('\ud800', False)]:
    inventory = dict(schemaVersion=1, os='linux', architecture='arm64',
                     collectedAt='2026-01-01T00:00:00Z', applications=[],
                     sources=[dict(id='fixture', status='available', command=[value])])
    for module in modules[1:]:
        try:
            if module is modules[1]:
                module.validate(inventory, 'linux')
            else:
                module.validate_inventory(inventory)
            accepted = True
        except ValueError:
            accepted = False
        assert accepted == valid, (module.__file__, repr(value))
        provenance_checks += 1
# Portable envelope validators retain identical Unicode acceptance for facts,
# while the bounded provenance identifier intentionally remains ASCII-only.
portable_checks = 0
for name, valid in [('界', True), ('\u0085', True), ('\ufeff', False), ('\ud800', False)]:
    inventory = dict(schemaVersion=1, os='linux', architecture='arm64',
                     collectedAt='2026-01-01T00:00:00Z', sources=[dict(id='fixture', status='available')],
                     applications=[dict(id='fixture', name=name, aliases=[], version=None)])
    doc = dict(schemaVersion=1, image='fixture', inventory=inventory,
               provenance=dict(extractionMode='work', evidenceId='fixture', rawSha256='0'*64,
                               collectorSha256='1'*64, aliasesSha256='2'*64))
    for module in modules[1:]:
        try:
            if module is modules[1]:
                module.validate_portable(doc, 'fixture', 'linux')
            else:
                module._portable(doc, 'fixture', 'linux')
            accepted = True
        except ValueError:
            accepted = False
        assert accepted == valid, (module.__file__, repr(name))
        portable_checks += 1
print(json.dumps({'checks': count, 'validators': len(modules), 'provenanceChecks': provenance_checks, 'portableChecks': portable_checks}))
