import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Transfer, type VmChannel } from '../src/transfer.js';
import { command } from '../src/util.js';

test('only byte-copy transport failures retry with retained diagnostics; execution is not replayed', async () => {
 const root = await mkdtemp(join(tmpdir(), 'relay-retry-'));
 try {
  await mkdir(join(root, 'guest')); await writeFile(join(root, 'source'), 'same exact bytes');
  let pushes = 0; const events: unknown[] = [];
  const channel: VmChannel = { exec: async (_vm, argv) => command(argv), push: async (_vm, source, destination) => { if (++pushes < 3) throw new Error('HTTP 409 scp failed: Permission denied (publickey,password)'); await copyFile(source, destination); }, pull: async (_vm, source, destination) => copyFile(source, destination) };
  const transfer = new Transfer(channel, 'test', process.execPath, { guestRoot: join(root, 'guest'), onRetry: async event => { events.push(event); } });
  await transfer.pushFile(join(root, 'source'), join(root, 'guest', 'file'));
  assert.equal(pushes, 3); assert.equal(events.length, 2);
  assert.equal(await readFile(join(root, 'guest', 'file'), 'utf8'), 'same exact bytes');
  pushes = 0; channel.push = async (_vm, _source, destination) => { pushes++; await writeFile(destination, 'corrupted'); };
  await assert.rejects(transfer.pushFile(join(root, 'source'), join(root, 'guest', 'file')), /checksum mismatch/);
  assert.equal(pushes, 1, 'hash mismatches do not retry');
  let metadata = 0;
  channel.exec = async (_vm, argv) => ++metadata === 1 ? { code: 255, stdout: '', stderr: 'admin@192.0.2.1: Permission denied (publickey,password).' } : command(argv);
  assert.ok((await transfer.scan(join(root, 'guest', 'file'))).length === 1);
  assert.ok(events.some((event: any) => event.operation === 'metadata'));
  metadata = 0;
  channel.exec = async () => { metadata++; return { code: 1, stdout: '', stderr: 'genuine guest error' }; };
  await assert.rejects(transfer.checked([process.execPath, '--version']), /genuine guest error/);
  assert.equal(metadata, 1, 'non-authentication guest errors never replay');
 } finally { await rm(root, { recursive: true, force: true }); }
});
