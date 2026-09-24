import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_AFTER_INTERVAL_MS, TARGETS, TARGET_PACKAGES, cachedTarball, integrityMatches, tarballName, tarballUrl, targetLaunches } from '../src/targets.js';
import { runTargets } from '../src/schema.js';

const context = { node: '/usr/bin/node', cuaDriver: '/opt/cua/cua-driver', packagesRoot: '/g/mcp/packages', workspace: '/g/workspace', outputDir: '/g/workspace/relay-run' };

test('the targets, their pins and the schema enum are defined in one place', () => {
  assert.deepEqual([...runTargets], ['cua', 'playwright', 'chrome-devtools']);
  assert.equal(runTargets, TARGETS);
  for (const closure of Object.values(TARGET_PACKAGES)) for (const pin of closure.packages) {
    assert.match(pin.version, /^\d+\.\d+\.\d+(-[\w.-]+)?$/, `${pin.name} is an exact version`);
    assert.match(pin.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, `${pin.name} has a sha512 integrity`);
  }
  assert.deepEqual(DEFAULT_AFTER_INTERVAL_MS, { cua: 500, playwright: 300, 'chrome-devtools': 300, command: 500 });
});

test('launch commands: cua-driver mcp, headed browser servers, no shell', () => {
  const launches = targetLaunches(context);
  assert.deepEqual(launches.cua, { command: '/opt/cua/cua-driver', args: ['mcp'], cwd: '/g/workspace' });
  assert.equal(launches.playwright.command, '/usr/bin/node');
  assert.equal(launches.playwright.args[0], '/g/mcp/packages/node_modules/@playwright/mcp/cli.js');
  assert.equal(launches['chrome-devtools'].args[0], '/g/mcp/packages/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js');
  for (const target of ['playwright', 'chrome-devtools'] as const) {
    assert.ok(!launches[target].args.some(arg => arg.startsWith('--headless')), `${target} stays headed`);
    assert.ok(launches[target].args.includes('--isolated'), `${target} uses a fresh profile`);
  }
  const withBrowser = targetLaunches({ ...context, browserExecutable: '/usr/bin/chromium' });
  assert.deepEqual(withBrowser.playwright.args.slice(-2), ['--executable-path', '/usr/bin/chromium']);
  assert.deepEqual(withBrowser['chrome-devtools'].args.slice(-2), ['--executablePath', '/usr/bin/chromium']);
});

test('tarball names and registry URLs follow npm, and the integrity check is exact', async t => {
  const pin = { name: '@playwright/mcp', version: '0.0.82', integrity: '' };
  assert.equal(tarballName(pin), 'playwright-mcp-0.0.82.tgz');
  assert.equal(tarballUrl(pin, 'https://registry.example/'), 'https://registry.example/@playwright/mcp/-/mcp-0.0.82.tgz');
  const bytes = Buffer.from('fixture tarball');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(integrityMatches(bytes, integrity), true);
  assert.equal(integrityMatches(Buffer.from('other'), integrity), false);
  assert.equal(integrityMatches(bytes, integrity.replace('sha512', 'sha1')), false);
  const cache = await mkdtemp(join(tmpdir(), 'relay-tarballs-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  let fetched = 0;
  const source = async () => { fetched++; return bytes; };
  const first = await cachedTarball(cache, { name: 'fixture', version: '1.0.0', integrity }, source);
  assert.equal((await readFile(first.path)).toString(), 'fixture tarball');
  await cachedTarball(cache, { name: 'fixture', version: '1.0.0', integrity }, source);
  assert.equal(fetched, 1, 'a verified cache entry is reused');
  await writeFile(first.path, 'tampered');
  await cachedTarball(cache, { name: 'fixture', version: '1.0.0', integrity }, source);
  assert.equal(fetched, 2, 'a cache entry that no longer matches is fetched again');
  await assert.rejects(cachedTarball(cache, { name: 'bad', version: '1.0.0', integrity }, async () => Buffer.from('wrong')), /does not match its pinned integrity/);
  await assert.rejects(readFile(join(cache, 'bad-1.0.0.tgz')), /ENOENT/, 'a mismatch is never cached');
});
