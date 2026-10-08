import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveBytes, archiveChunks, unpackArchive, type ArchiveEntry } from '../src/archive.js';
import { Transfer, type VmChannel } from '../src/transfer.js';
import { command, hash, inventory } from '../src/util.js';

const entry = (path: string, body: string): ArchiveEntry => ({ path, bytes: Buffer.byteLength(body), sha256: hash(body) });
const pack = (files: Array<{ path: string; body: string; bytes?: number; sha256?: string }>) =>
 Buffer.concat(files.flatMap(file => [Buffer.from(`${JSON.stringify({ path: file.path, bytes: file.bytes ?? Buffer.byteLength(file.body) })}\n`), Buffer.from(file.body), Buffer.from(`${JSON.stringify({ sha256: file.sha256 ?? hash(file.body) })}\n`)]));

test('an archive unpacks byte for byte, and its size is known before the guest writes it (AD-8)', async t => {
 const root = await mkdtemp(join(tmpdir(), 'relay-archive-')); t.after(() => rm(root, { recursive: true, force: true }));
 const files = [{ path: 'records/a.json', body: '{"a":1}' }, { path: 'snapshots/s/b.png', body: 'png\nwith\nnewlines' }, { path: 'empty', body: '' }];
 const bytes = pack(files); await writeFile(join(root, 'archive'), bytes);
 const expected = files.map(file => entry(file.path, file.body));
 assert.equal(archiveBytes(expected), bytes.length);
 await unpackArchive(join(root, 'archive'), join(root, 'out'), expected);
 for (const file of files) assert.equal(await readFile(join(root, 'out', file.path), 'utf8'), file.body);
});

test('an archive is rejected for traversal, unrequested or duplicate paths, wrong sizes or hashes, truncation and trailing bytes (AD-8)', async t => {
 const root = await mkdtemp(join(tmpdir(), 'relay-archive-bad-')); t.after(() => rm(root, { recursive: true, force: true }));
 const a = { path: 'a', body: 'alpha' }, b = { path: 'b', body: 'beta' };
 const cases: Array<[string, Buffer, ArchiveEntry[], RegExp]> = [
  ['traversal', pack([{ path: '../a', body: 'alpha' }]), [entry('../a', 'alpha')], /Invalid relative path/],
  ['absolute', pack([{ path: '/etc/a', body: 'alpha' }]), [entry('/etc/a', 'alpha')], /Invalid relative path/],
  ['unrequested', pack([b]), [entry('a', 'alpha')], /Unexpected archive entry/],
  ['duplicate', pack([a, a]), [entry('a', 'alpha'), entry('b', 'beta')], /Unexpected archive entry/],
  ['size', pack([{ ...a, bytes: 4 }]), [entry('a', 'alpha')], /Unexpected archive entry/],
  ['hash line', pack([{ ...a, sha256: hash('other') }]), [entry('a', 'alpha')], /checksum mismatch/],
  ['expected hash', pack([a]), [{ ...entry('a', 'alpha'), sha256: hash('other') }], /checksum mismatch/],
  ['truncated', pack([a, b]).subarray(0, 30), [entry('a', 'alpha'), entry('b', 'beta')], /truncated/],
  ['trailing', Buffer.concat([pack([a]), Buffer.from('x')]), [entry('a', 'alpha')], /trailing bytes/],
  ['missing', pack([a]), [entry('a', 'alpha'), entry('b', 'beta')], /truncated/],
 ];
 for (const [name, bytes, expected, error] of cases) {
  const archive = join(root, `${name}.archive`); await writeFile(archive, bytes);
  await assert.rejects(unpackArchive(archive, join(root, name), expected), error, name);
 }
 await mkdir(join(root, 'linked')); await symlink(join(root, 'elsewhere'), join(root, 'linked', 'a'));
 await writeFile(join(root, 'link.archive'), pack([a]));
 await assert.rejects(unpackArchive(join(root, 'link.archive'), join(root, 'linked'), [entry('a', 'alpha')]), /EEXIST/, 'an existing link is never written through');
});

test('archive requests are split so no guest command carries more than the path budget', () => {
 const files = Array.from({ length: 10 }, (_, n) => ({ path: `${n}`.padStart(10, 'x') }));
 const chunks = archiveChunks(files, 33);
 assert.deepEqual(chunks.map(chunk => chunk.length), [3, 3, 3, 1]);
 assert.deepEqual(chunks.flat(), files);
});

const guestChannel = (log: string[]) => ({
 exec: async (_name: string, argv: string[]) => { log.push('exec'); return command(argv); },
 push: async (_name: string, l: string, r: string) => copyFile(l, r),
 pull: async (_name: string, r: string, l: string) => { log.push(`pull ${r}`); return copyFile(r, l); },
}) satisfies VmChannel;

test('pullVerified fetches what the host lacks in one archive, with a fixed number of requests (AD-9)', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-archive-pull-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), state = join(guest, 'state'), host = join(root, 'host');
 const write = async (count: number) => { for (let n = 0; n < count; n++) { await mkdir(join(state, 'records', String(n % 7)), { recursive: true }); await writeFile(join(state, 'records', String(n % 7), `${n}.json`), JSON.stringify({ n })); } };
 const requests = async (count: number) => {
  await rm(guest, { recursive: true, force: true }); await write(count);
  const log: string[] = [];
  const transfer = new Transfer(guestChannel(log), 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp') });
  const local = join(host, String(count), 'state');
  await transfer.pullVerified(state, local, guest, host);
  assert.deepEqual(await inventory(local), await inventory(state));
  assert.deepEqual(await readdir(guest), ['state'], 'the guest archive and frames are removed');
  assert.ok(!(await readdir(local)).some(name => name.startsWith('.relay-archive-')), 'the host staging is removed');
  assert.ok(log.filter(line => line.startsWith('pull ')).every(line => /\/\.(?:inventory|archive)-/.test(line)), 'no file is pulled on its own');
  return log.length;
 };
 assert.equal(await requests(5), await requests(200), 'the requests do not grow with the files');
});

test('pullVerified falls back to the per-file pull when the archive fails, and says why (AD-10)', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-archive-fallback-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), state = join(guest, 'state'), host = join(root, 'host');
 await mkdir(join(state, 'snapshots'), { recursive: true });
 await writeFile(join(state, 'snapshots', 'a.png'), 'a'); await writeFile(join(state, 'journal'), 'j');
 const log: string[] = [], fallbacks: string[] = [];
 const channel = guestChannel(log);
 const pull = channel.pull;
 channel.pull = async (name, r, l) => { if (r.includes('/.archive-')) { await pull(name, r, l); await writeFile(l, 'corrupt'); return; } return pull(name, r, l); };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp'), onArchiveFallback: async event => { fallbacks.push(event.diagnostic); } });
 const local = join(host, 'state');
 await transfer.pullVerified(state, local, guest, host);
 assert.deepEqual(await inventory(local), await inventory(state));
 assert.equal(fallbacks.length, 1); assert.match(fallbacks[0], /Archive size mismatch/);
 assert.deepEqual(log.filter(line => line.startsWith('pull ') && !/\/\.(?:inventory|archive)-/.test(line)).sort(), [`pull ${join(state, 'journal')}`, `pull ${join(state, 'snapshots', 'a.png')}`]);
 assert.deepEqual(await readdir(guest), ['state']);
});

test('the guest refuses to archive a link or a file outside the tree, and leaves no partial archive', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-archive-guest-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), state = join(guest, 'state'), host = join(root, 'host');
 await mkdir(state, { recursive: true }); await writeFile(join(root, 'secret'), 'secret'); await writeFile(join(state, 'a'), 'a');
 const fallbacks: string[] = [];
 const transfer = new Transfer(guestChannel([]), 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp'), onArchiveFallback: async event => { fallbacks.push(event.diagnostic); } });
 // The scan sees a regular file; it becomes a link before the archive reads it.
 const channel = (transfer as unknown as { vm: VmChannel }).vm, exec = channel.exec;
 channel.exec = async (name, argv, ...rest) => {
  if (argv.length > 6 && argv[2].includes('Not a regular file')) { await rm(join(state, 'a')); await symlink(join(root, 'secret'), join(state, 'a')); }
  return exec(name, argv, ...rest);
 };
 await assert.rejects(transfer.pullVerified(state, join(host, 'state'), guest, host), /symlink|Source changed|inventory mismatch/);
 assert.match(fallbacks[0], /Not a regular file|symlink/);
 assert.deepEqual(await readdir(guest), ['state']);
});
