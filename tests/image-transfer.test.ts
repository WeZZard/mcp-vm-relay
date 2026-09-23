import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Transfer, ImageTransferError, type ImageTransferErrorCode, type VmChannel } from '../src/transfer.js';
import { command, hash } from '../src/util.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const expected = { sha256: hash(png), bytes: png.length };
const code = (wanted: ImageTransferErrorCode) => (error: unknown) => error instanceof ImageTransferError && error.code === wanted;
const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-image-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guest = join(root, 'guest'), host = join(root, 'host');
  await mkdir(guest); await mkdir(host);
  const remote = join(guest, 'image.png'), local = join(host, 'image.png');
  await writeFile(remote, png);
  const pulls: string[] = [], execs: string[][] = [];
  const channel: VmChannel = {
    exec: async (_name, argv) => { execs.push(argv); return command(argv); },
    push: async () => assert.fail('image retrieval must never push'),
    pull: async (_name, r, l) => { pulls.push(r); return copyFile(r, l); },
  };
  const transfer = new Transfer(channel, 'fake-image-vm', process.execPath);
  const pull = (identity: typeof expected | undefined = expected, options = {}) => transfer.pullImage(remote, local, guest, host, identity, options);
  return { root, guest, host, remote, local, pulls, execs, channel, transfer, pull };
}

test('JSONL metadata preserves original bytes, validates lines, and shares the delivery budget', async t => {
  const f = await fixture(t);
  const journal = join(f.guest, 'captures.jsonl'), localJournal = join(f.host, 'captures.jsonl');
  const bytes = Buffer.from('{"phase":"before"}\r\n\n  \n{"phase":"after"}\n');
  await writeFile(journal, bytes);
  const attemptBudget = { remaining: 2 }, deadline = Date.now() + 5000;
  assert.deepEqual(await f.transfer.pullImageMetadata(journal, localJournal, f.guest, f.host, { metadataFormat: 'jsonl', attemptBudget, deadline }), bytes);
  assert.equal(attemptBudget.remaining, 1);
  assert.deepEqual(await readFile(localJournal), bytes);
  assert.deepEqual(await f.pull(expected, { attemptBudget, deadline }), png);
  assert.equal(attemptBudget.remaining, 0);
  assert.deepEqual(await f.transfer.pullImageMetadata(journal, localJournal, f.guest, f.host, { metadataFormat: 'jsonl', attemptBudget, deadline }), bytes);
  assert.equal(attemptBudget.remaining, 0, 'cached journal consumes no copy attempt');
});

test('JSONL rejects a malformed line or invalid UTF-8 before publication, while JSON remains the default', async t => {
  for (const bytes of [Buffer.from('{}\n{broken}\n'), Buffer.from([123, 125, 10, 34, 255, 34, 10])]) {
    const f = await fixture(t); await writeFile(f.remote, bytes);
    await assert.rejects(f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host, { metadataFormat: 'jsonl' }), code('integrity-failed'));
    assert.deepEqual(await readdir(f.host), []);
  }
  const f = await fixture(t); await writeFile(f.remote, '{}\n{}\n');
  await assert.rejects(f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host), code('integrity-failed'));
  const controller = new AbortController(); controller.abort(); const attemptBudget = { remaining: 3 };
  await assert.rejects(f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host, { metadataFormat: 'jsonl', signal: controller.signal, attemptBudget }), code('transfer-failed'));
  assert.equal(attemptBudget.remaining, 3);
});

test('metadata and image byte copies share one attempt budget, including retries', async t => {
  const f = await fixture(t);
  const metadata = join(f.guest, 'receipt.json'), receipt = join(f.host, 'receipt.json');
  await writeFile(metadata, '{"saved":true}');
  const attemptBudget = { remaining: 3 };
  await f.transfer.imageFact(f.remote, f.guest, { attemptBudget });
  assert.equal(attemptBudget.remaining, 3, 'stat/hash commands consume no byte-copy attempts');
  await f.transfer.pullImageMetadata(metadata, receipt, f.guest, f.host, { attemptBudget });
  assert.equal(attemptBudget.remaining, 2);
  let imageAttempts = 0;
  f.channel.pull = async () => { imageAttempts++; throw Error('connection lost'); };
  await assert.rejects(f.pull(expected, { attemptBudget }), code('transfer-failed'));
  assert.equal(imageAttempts, 2); assert.equal(attemptBudget.remaining, 0);
  await assert.rejects(f.pull(expected, { attemptBudget }), code('transfer-failed'));
  assert.equal(imageAttempts, 2, 'exhausted shared budget cannot dispatch another copy');
  await writeFile(f.local, png);
  assert.deepEqual(await f.pull(expected, { attemptBudget }), png, 'verified image cache needs no attempt');
  assert.deepEqual(await f.transfer.pullImageMetadata(metadata, receipt, f.guest, f.host, { attemptBudget }), Buffer.from('{"saved":true}'));
  assert.equal(attemptBudget.remaining, 0);
});

test('metadata retries consume the shared budget before a later image copy', async t => {
  const f = await fixture(t);
  const metadata = join(f.guest, 'receipt.json'); await writeFile(metadata, '{}');
  const attemptBudget = { remaining: 3 }; let copies = 0;
  f.channel.pull = async (_name, r, l) => { if (++copies === 1) throw Error('HTTP 503'); return copyFile(r, l); };
  await f.transfer.pullImageMetadata(metadata, join(f.host, 'receipt.json'), f.guest, f.host, { attemptBudget });
  assert.equal(attemptBudget.remaining, 1);
  assert.deepEqual(await f.pull(expected, { attemptBudget }), png);
  assert.equal(copies, 3); assert.equal(attemptBudget.remaining, 0);
});

test('cancellation before a byte-copy dispatch never consumes the shared budget', async t => {
  const f = await fixture(t), controller = new AbortController();
  const attemptBudget = { remaining: 3 };
  const exec = f.channel.exec; let metadataCalls = 0;
  f.channel.exec = async (...args) => {
    const result = await exec(...args);
    if (++metadataCalls === 2) controller.abort();
    return result;
  };
  await assert.rejects(f.pull(expected, { signal: controller.signal, attemptBudget }), code('transfer-failed'));
  assert.equal(attemptBudget.remaining, 3); assert.equal(f.pulls.length, 0);
  await assert.rejects(f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host, { signal: controller.signal, attemptBudget }), code('transfer-failed'));
  assert.equal(attemptBudget.remaining, 3); assert.equal(f.pulls.length, 0);
});

test('JSON image metadata is verified, immutable, and reused only against a matching guest hash', async t => {
  const f = await fixture(t);
  const json = Buffer.from(JSON.stringify({ executionId: 'saved', action: { phase: 'after' } }));
  await writeFile(f.remote, json);
  const pull = () => f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host);
  assert.deepEqual(await pull(), json);
  assert.deepEqual(await readFile(f.local), json);
  assert.equal(f.pulls.length, 1);
  assert.deepEqual(await pull(), json);
  assert.equal(f.pulls.length, 1, 'matching local metadata does not copy again');
  await writeFile(f.remote, JSON.stringify({ executionId: 'changed' }));
  await assert.rejects(pull(), code('integrity-failed'));
  assert.deepEqual(await readFile(f.local), json);
  await assert.rejects(f.transfer.imageFact(f.remote, f.guest), code('unsafe-path'));
  await assert.rejects(f.transfer.pullImage(f.remote, join(f.host, 'not-image'), f.guest, f.host), code('unsafe-path'));
});

test('JSON metadata rejects malformed JSON and invalid UTF-8 before publication', async t => {
  for (const bytes of [Buffer.from('{invalid'), Buffer.from([34, 255, 34]), png]) {
    const f = await fixture(t); await writeFile(f.remote, bytes);
    await assert.rejects(f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host), code('integrity-failed'));
    assert.deepEqual(await readdir(f.host), []);
  }
});

test('JSON metadata enforces 4 MiB before copy and accepts the exact boundary', async t => {
  const f = await fixture(t);
  const json = Buffer.from('"' + 'a'.repeat(4 * 1024 * 1024 - 2) + '"');
  await writeFile(f.remote, json);
  assert.deepEqual(await f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host), json);
  await rm(f.local); await truncate(f.remote, 4 * 1024 * 1024 + 1);
  await assert.rejects(f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host), code('unsafe-path'));
  assert.equal(f.pulls.length, 1);
  assert.deepEqual(await readdir(f.host), []);
});

test('JSON metadata shares cancellation and deadline propagation without late publication', async t => {
  const f = await fixture(t); await writeFile(f.remote, '{"saved":true}');
  const controller = new AbortController(), entered = deferred(); let signal: AbortSignal | undefined;
  f.channel.pull = async (_name, _r, _l, options) => { signal = options?.signal; entered.resolve(); return new Promise(() => {}); };
  const operation = f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host, { signal: controller.signal, deadline: Date.now() + 5000 });
  await entered.promise; controller.abort(); await assert.rejects(operation, code('transfer-failed'));
  assert.equal(signal?.aborted, true); assert.deepEqual(await readdir(f.host), []);
  const calls = f.execs.length;
  await assert.rejects(f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host, { deadline: Date.now() - 1 }), code('transfer-failed'));
  assert.equal(f.execs.length, calls);
});

test('JSON metadata source mutation and racing local conflict preserve original files', async t => {
  for (const changeSource of [true, false]) {
    const f = await fixture(t); await writeFile(f.remote, '{"saved":true}');
    const conflicting = Buffer.from('{"different":true}');
    f.channel.pull = async (_name, r, l) => { await copyFile(r, l); await writeFile(changeSource ? r : f.local, conflicting); };
    await assert.rejects(f.transfer.pullImageMetadata(f.remote, f.local, f.guest, f.host), code('integrity-failed'));
    if (changeSource) assert.deepEqual(await readdir(f.host), []);
    else assert.deepEqual(await readFile(f.local), conflicting);
  }
});

test('imageFact freezes bounded identity; image pull copies only selected file and publishes original', async t => {
  const f = await fixture(t);
  await writeFile(join(f.guest, 'sibling.png'), 'do not extract');
  assert.deepEqual(await f.transfer.imageFact(f.remote, f.guest), { path: f.remote, ...expected });
  assert.equal(f.pulls.length, 0);
  assert.deepEqual(await f.pull(), png);
  assert.deepEqual(await readFile(f.local), png);
  assert.deepEqual(f.pulls, [f.remote]);
  assert.deepEqual(await readdir(f.host), ['image.png']);
});

test('first retrieval can establish identity without expected; cache needs explicit expected and no guest', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.transfer.pullImage(f.remote, f.local, f.guest, f.host), png);
  await assert.rejects(f.transfer.pullImage(f.remote, f.local, f.guest, f.host), code('integrity-failed'));
  f.channel.exec = async () => assert.fail('verified cache requires no guest metadata');
  f.channel.pull = async () => assert.fail('verified cache requires no guest copy');
  await rm(f.remote);
  assert.deepEqual(await f.pull(), png);
});

test('existing conflicting bytes are never overwritten or retried', async t => {
  const f = await fixture(t);
  const original = Buffer.from('keep this original'); await writeFile(f.local, original);
  await assert.rejects(f.pull(), code('integrity-failed'));
  assert.deepEqual(await readFile(f.local), original);
  assert.equal(f.execs.length, 0); assert.equal(f.pulls.length, 0);
});

test('atomic publication preserves racing conflict and reuses matching racing original', async t => {
  for (const matching of [false, true]) {
    const f = await fixture(t);
    const winner = matching ? png : Buffer.from('concurrent original');
    f.channel.pull = async (_name, r, l) => { assert.notEqual(l, f.local); await copyFile(r, l); await writeFile(f.local, winner, { flag: 'wx' }); };
    if (matching) assert.deepEqual(await f.pull(), png);
    else await assert.rejects(f.pull(), code('integrity-failed'));
    assert.deepEqual(await readFile(f.local), winner);
    assert.deepEqual(await readdir(f.host), ['image.png']);
  }
});

test('unsafe lexical paths fail before any guest operation', async t => {
  const f = await fixture(t);
  for (const remote of ['relative.png', join(f.guest, '..') + '/outside.png', `${f.guest}/nested/../image.png`, `${f.guest}/bad\\name`, `${f.guest}/bad\0name`, join(f.root, 'outside')]) {
    await assert.rejects(f.transfer.pullImage(remote, f.local, f.guest, f.host, expected), code('unsafe-path'));
    await assert.rejects(f.transfer.imageFact(remote, f.guest), code('unsafe-path'));
  }
  await assert.rejects(f.transfer.pullImage(f.remote, join(f.root, 'outside'), f.guest, f.host, expected), code('unsafe-path'));
  assert.equal(f.execs.length, 0); assert.equal(f.pulls.length, 0);
});

test('missing source, directory, symlinks, FIFO and oversize source fail without byte copy', async t => {
  const f = await fixture(t);
  await rm(f.remote);
  await assert.rejects(f.pull(), code('image-missing'));
  await mkdir(f.remote); await assert.rejects(f.pull(), code('unsafe-path')); await rm(f.remote, { recursive: true });
  await writeFile(join(f.guest, 'real.png'), png); await symlink(join(f.guest, 'real.png'), f.remote);
  await assert.rejects(f.pull(), code('unsafe-path')); await rm(f.remote);
  await command(['/usr/bin/mkfifo', f.remote]);
  await assert.rejects(f.pull(), code('unsafe-path')); await rm(f.remote);
  await writeFile(f.remote, ''); await truncate(f.remote, 64 * 1024 * 1024 + 1);
  await assert.rejects(f.pull(), code('unsafe-path'));
  assert.equal(f.pulls.length, 0);
});

test('host and guest symlink ancestors fail, including ancestor substitution during copy', async t => {
  const f = await fixture(t);
  await mkdir(join(f.guest, 'nested')); const nested = join(f.guest, 'nested/image.png'); await writeFile(nested, png);
  await symlink(f.guest, join(f.guest, 'alias'));
  await assert.rejects(f.transfer.pullImage(join(f.guest, 'alias/image.png'), f.local, f.guest, f.host, expected), code('unsafe-path'));
  await symlink(f.host, join(f.host, 'alias'));
  await assert.rejects(f.transfer.pullImage(f.remote, join(f.host, 'alias/image.png'), f.guest, f.host, expected), code('unsafe-path'));
  f.channel.pull = async (_name, r, l) => { await copyFile(r, l); await rename(join(f.guest, 'nested'), join(f.guest, 'old')); await symlink(join(f.guest, 'old'), join(f.guest, 'nested')); };
  await assert.rejects(f.transfer.pullImage(nested, f.local, f.guest, f.host, expected), code('unsafe-path'));
  await assert.rejects(readFile(f.local), { code: 'ENOENT' });
});

test('changed source or corrupted copy is an integrity failure with no retries', async t => {
  for (const mutateSource of [true, false]) {
    const f = await fixture(t); let attempts = 0;
    f.channel.pull = async (_name, r, l) => { attempts++; await copyFile(r, l); await writeFile(mutateSource ? r : l, Buffer.concat([png, Buffer.from('changed')])); };
    await assert.rejects(f.pull(), code('integrity-failed'));
    assert.equal(attempts, 1); assert.deepEqual(await readdir(f.host), []);
  }
});

test('same-byte source replacement is detected by metadata identity recheck', async t => {
  const f = await fixture(t);
  f.channel.pull = async (_name, r, l) => { await copyFile(r, l); const replacement = join(f.guest, 'replacement'); await writeFile(replacement, png); await rename(replacement, r); };
  await assert.rejects(f.pull(), code('integrity-failed'));
  assert.deepEqual(await readdir(f.host), []);
});

test('unsupported image format and corrupt expected hash fail closed', async t => {
  const f = await fixture(t);
  await writeFile(f.remote, 'not an image');
  await assert.rejects(f.transfer.pullImage(f.remote, f.local, f.guest, f.host), code('unsafe-path'));
  await assert.rejects(f.pull({ sha256: 'bad', bytes: 10 }), code('integrity-failed'));
  await writeFile(f.remote, png);
  await assert.rejects(f.pull({ ...expected, sha256: '0'.repeat(64) }), code('integrity-failed'));
  assert.deepEqual(await readdir(f.host), []);
});

test('image byte copy retries eligible failures at most three times with fresh staging paths', async t => {
  const f = await fixture(t); const paths: string[] = [];
  f.channel.pull = async (_name, _r, l) => { paths.push(l); await writeFile(l, 'partial'); throw Error('scp connection lost'); };
  await assert.rejects(f.pull(), code('transfer-failed'));
  assert.equal(paths.length, 3); assert.equal(new Set(paths).size, 3);
  assert.equal(f.execs.length, 4, 'one initial metadata command and one source recheck per copy attempt');
  assert.deepEqual(await readdir(f.host), []);
});

test('third eligible copy can succeed; nontransient failures and metadata failure are not retried', async t => {
  const f = await fixture(t); let attempts = 0;
  f.channel.pull = async (_name, r, l) => { if (++attempts < 3) throw Error('HTTP 503'); await copyFile(r, l); };
  assert.deepEqual(await f.pull(), png); assert.equal(attempts, 3);
  await rm(f.local); attempts = 0;
  f.channel.pull = async () => { attempts++; throw Error('scp: permission denied'); };
  await assert.rejects(f.pull(), code('transfer-failed')); assert.equal(attempts, 1);
  let metadata = 0;
  f.channel.exec = async () => { metadata++; return { code: 255, stdout: '', stderr: 'Permission denied (publickey,password)' }; };
  await assert.rejects(f.pull(), code('transfer-failed')); assert.equal(metadata, 1);
});

test('cancellation reaches metadata and ignored late metadata cannot dispatch a copy', async t => {
  const f = await fixture(t); const entered = deferred(), late = deferred<{ stdout: string; stderr: string; code: number }>();
  const controller = new AbortController(); let signal: AbortSignal | undefined;
  f.channel.exec = async (_name, _argv, timeout, options) => { signal = options?.signal; assert.ok(timeout! <= 90_000); assert.equal(timeout, options?.timeoutMs); entered.resolve(); return late.promise; };
  const operation = f.pull(expected, { signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(operation, code('transfer-failed'));
  assert.equal(signal?.aborted, true);
  late.resolve({ code: 0, stdout: JSON.stringify({ path: f.remote, ...expected, identity: 'late' }), stderr: '' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pulls.length, 0); assert.deepEqual(await readdir(f.host), []);
});

test('cancellation reaches byte copy; legacy late completion never publishes', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(), finished = deferred();
  const controller = new AbortController(); let signal: AbortSignal | undefined;
  f.channel.pull = async (_name, r, l, options) => {
    signal = options?.signal; assert.ok(options!.timeoutMs! <= 90_000); entered.resolve(); await release.promise;
    await mkdir(join(l, '..'), { recursive: true }); await copyFile(r, l); finished.resolve();
  };
  const operation = f.pull(expected, { signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(operation, code('transfer-failed'));
  assert.equal(signal?.aborted, true);
  release.resolve(); await finished.promise;
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(readFile(f.local), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.host), []);
});

test('staged bytes are reverified after final guest metadata command', async t => {
  const f = await fixture(t); let staged: string | undefined;
  f.channel.pull = async (_name, r, l) => { await copyFile(r, l); staged = l; };
  const exec = f.channel.exec;
  f.channel.exec = async (...args) => {
    const result = await exec(...args);
    if (staged) await writeFile(staged, Buffer.concat([png, Buffer.from('late staging corruption')]));
    return result;
  };
  await assert.rejects(f.pull(), code('integrity-failed'));
  assert.deepEqual(await readdir(f.host), []);
});

test('byte-copy deadline aborts even a legacy channel that never settles', async t => {
  const f = await fixture(t); let signal: AbortSignal | undefined, timeout: number | undefined;
  f.channel.exec = async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ path: f.remote, ...expected, identity: 'stable' }) });
  f.channel.pull = async (_name, _r, _l, options) => { signal = options?.signal; timeout = options?.timeoutMs; return new Promise(() => {}); };
  await assert.rejects(f.pull(expected, { deadline: Date.now() + 500 }), code('transfer-failed'));
  assert.ok(timeout! > 0 && timeout! <= 500);
  assert.equal(signal?.aborted, true);
  assert.deepEqual(await readdir(f.host), []);
});

test('image metadata accepts the 64 MiB boundary and rejects the next byte', async t => {
  const f = await fixture(t);
  await truncate(f.remote, 64 * 1024 * 1024);
  const fact = await f.transfer.imageFact(f.remote, f.guest);
  assert.equal(fact.bytes, 64 * 1024 * 1024);
  await truncate(f.remote, 64 * 1024 * 1024 + 1);
  await assert.rejects(f.transfer.imageFact(f.remote, f.guest), code('unsafe-path'));
  assert.equal(f.pulls.length, 0);
});

test('expired and pre-aborted budgets dispatch nothing; shared metadata deadline bounds ignored channels', async t => {
  const f = await fixture(t);
  await assert.rejects(f.pull(expected, { deadline: Date.now() - 1 }), code('transfer-failed'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.pull(expected, { signal: controller.signal }), code('transfer-failed'));
  await assert.rejects(f.transfer.imageFact(f.remote, f.guest, { signal: controller.signal }), code('transfer-failed'));
  assert.equal(f.execs.length, 0); assert.equal(f.pulls.length, 0);
  let signal: AbortSignal | undefined;
  f.channel.exec = async (_name, _argv, _timeout, options) => { signal = options?.signal; return new Promise(() => {}); };
  await assert.rejects(f.transfer.imageFact(f.remote, f.guest, { deadline: Date.now() + 30 }), code('transfer-failed'));
  assert.equal(signal?.aborted, true);
});
