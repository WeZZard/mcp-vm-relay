import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSearch } from '../src/search-diagnostics.js';
const result = { applications: [], truncated: false };
async function fixture(t: any) { const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-search-'))); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('diagnostics correlate successful and failed searches without ownership records', async t => {
  const root = await fixture(t);
  const success = await recordSearch(root, { name: ' Firefox ' }, { result }, { toolCallId: 'call-1' });
  const record = JSON.parse(await readFile(success.path, 'utf8'));
  assert.equal(record.toolCallId, 'call-1'); assert.equal(record.query.name, 'firefox');
  assert.equal(record.truncated, false); assert.match(record.resultSha256, /^[a-f0-9]{64}$/);
  const failed = await recordSearch(root, { name: 'Firefox' }, { error: new Error('unavailable') });
  const error = JSON.parse(await readFile(failed.path, 'utf8'));
  assert.equal(error.status, 'error'); assert.equal('truncated' in error, false);
  assert.deepEqual(await readdir(root), ['search-diagnostics']);
});
test('error diagnostics never persist arbitrary upstream messages', async t => {
  const root = await fixture(t);
  const saved = await recordSearch(root, { name: 'Firefox' }, { error: new Error('Authorization: Bearer private-token https://user:password@example.test') });
  const text = await readFile(saved.path, 'utf8');
  assert.doesNotMatch(text, /private-token|password|Authorization/);
  assert.equal(JSON.parse(text).status, 'error');
});
test('retention rejects incomplete or extended recognized records without deleting them', async t => {
  const root = await fixture(t);
  const first = await recordSearch(root, { name: 'x' }, { result }, { now: new Date('2026-01-01T00:00:00Z') });
  const original = JSON.parse(await readFile(first.path, 'utf8'));
  for (const invalid of [{ schemaVersion: 1, id: original.id, at: original.at }, { ...original, foreign: true }, { ...original, bytes: -1 }, { ...original, applications: 2, installations: 1 }, { ...original, applications: 0, installations: 1 }]) {
    await writeFile(first.path, JSON.stringify(invalid));
    await assert.rejects(recordSearch(root, { name: 'x' }, { result }, { now: new Date('2026-03-01T00:00:00Z') }), /Invalid search diagnostic/);
    assert.deepEqual(JSON.parse(await readFile(first.path, 'utf8')), invalid);
  }
});
test('retention removes records older than 30 days', async t => {
  const root = await fixture(t);
  await recordSearch(root, { name: 'x' }, { result }, { now: new Date('2026-01-01T00:00:00Z') });
  await recordSearch(root, { name: 'x' }, { result }, { now: new Date('2026-02-02T00:00:00Z') });
  assert.equal((await readdir(join(root, 'search-diagnostics'))).length, 1);
});
test('retention keeps at most 256 records and prunes oldest first', async t => {
  const root = await fixture(t);
  const first = await recordSearch(root, { name: 'x' }, { result }, { now: new Date('2026-03-01T00:00:00Z') });
  const original = JSON.parse(await readFile(first.path, 'utf8'));
  const directory = join(root, 'search-diagnostics');
  for (let i = 1; i < 256; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const at = new Date(Date.parse(original.at) + i * 1000).toISOString();
    await writeFile(join(directory, `${at.replace(/:/g, '-')}-${id}.json`), JSON.stringify({ ...original, id, at }), { mode: 0o600 });
  }
  await recordSearch(root, { name: 'x' }, { result }, { now: new Date('2026-03-02T00:00:00Z') });
  assert.equal((await readdir(directory)).length, 256);
  await assert.rejects(readFile(first.path), { code: 'ENOENT' });
});
test('clock rollback retains the incoming record and applies count limit to existing timestamp/UUID order', async t => {
  const root = await fixture(t);
  const first = await recordSearch(root, { name: 'x' }, { result }, { now: new Date('2026-03-02T00:00:00Z') });
  const original = JSON.parse(await readFile(first.path, 'utf8'));
  const directory = join(root, 'search-diagnostics');
  for (let i = 1; i < 256; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    await writeFile(join(directory, `${original.at.replace(/:/g, '-')}-${id}.json`), JSON.stringify({ ...original, id }), { mode: 0o600 });
  }
  const before = (await readdir(directory)).sort();
  const incoming = await recordSearch(root, { name: 'x' }, { result }, { now: new Date('2026-03-01T00:00:00Z') });
  assert.equal((await readdir(directory)).length, 256);
  await assert.rejects(readFile(join(directory, before[0]!)), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(incoming.path, 'utf8')).at, '2026-03-01T00:00:00.000Z');
});
test('foreign files and directory symlinks fail explicitly without deleting targets', async t => {
  const root = await fixture(t);
  await recordSearch(root, { name: 'x' }, { result });
  const path = join(root, 'search-diagnostics', 'foreign.txt');
  await writeFile(path, 'preserve');
  await assert.rejects(recordSearch(root, { name: 'x' }, { result }), /Unrecognized/);
  assert.equal(await readFile(path, 'utf8'), 'preserve');
  const link = join(root, 'link'); await symlink(root, link);
  await assert.rejects(recordSearch(link, { name: 'x' }, { result }), /Unsafe/);
});
