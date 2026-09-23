import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, symlink, readdir, rename, realpath, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transfer, type VmChannel } from '../src/transfer.js';
import { command, inventory, within } from '../src/util.js';
import { probeLocal } from '../src/probe.js';

test('real file transfer checks source and destination; rejects mutation and symlinks', async () => {
 const root = await mkdtemp(join(tmpdir(), 'relay-transfer-'));
 try {
  const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'a'), 'hello');
  const channel: VmChannel = { exec: async (_name, argv) => command(argv), push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => copyFile(r, l) };
  const transfer = new Transfer(channel, 'fake-vm', process.execPath);
  await transfer.pushFile(join(source, 'a'), join(root, 'staged', 'a'));
  await transfer.pullVerified(source, join(root, 'delivered'));
  assert.deepEqual(await inventory(source), await inventory(join(root, 'delivered')));
  await symlink('/etc/passwd', join(source, 'link'));
  await assert.rejects(transfer.pullVerified(source, join(root, 'bad')), /symlink/);
  await rm(join(source, 'link'));
  channel.pull = async (_name, r, l) => { await copyFile(r, l); await writeFile(l, 'corrupted'); };
  await assert.rejects(transfer.pullVerified(join(source, 'a'), join(root, 'bad-file')), /checksum mismatch/);
  channel.pull = async (_name, r, l) => { await copyFile(r, l); await writeFile(r, 'source changed'); };
  await assert.rejects(transfer.pullVerified(join(source, 'a'), join(root, 'changed')), /Source changed/);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('inventory frames survive the vm-service 64000-character stdout tail and are cleaned', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-frame-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), source = join(guest, 'workspace'), temp = join(root, 'host-temp');
 await mkdir(source, { recursive: true });
 await Promise.all(Array.from({ length: 750 }, (_, n) => writeFile(join(source, `${String(n).padStart(4, '0')}-${'long-name-'.repeat(9)}`), String(n))));
 const original = await inventory(source); assert.ok(JSON.stringify(original).length > 64000);
 const stdoutSizes: number[] = [], pulled: string[] = [];
 const channel: VmChannel = {
  exec: async (_name, argv) => { const result = await command(argv, { maxBytes: 64 * 1024 * 1024 }); stdoutSizes.push(result.stdout.length); return { ...result, stdout: result.stdout.slice(-64000) }; },
  push: async (_name, l, r) => copyFile(l, r),
  pull: async (_name, r, l) => { pulled.push(r); return copyFile(r, l); },
 };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: temp });
 assert.deepEqual(await transfer.scan(source, guest), original);
 assert.ok(pulled.some(path => path.startsWith(join(guest, '.inventory-'))));
 assert.ok(stdoutSizes.every(size => size < 1000), 'exec only carries bounded acknowledgements');
 assert.deepEqual(await readdir(guest), ['workspace']); assert.deepEqual(await readdir(temp), []);
});

test('file framing accepts the full 10000-file limit and rejects the next file', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-frame-limit-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const source = join(root, 'workspace'); await mkdir(source);
 for (let start = 0; start < 10000; start += 100) await Promise.all(Array.from({ length: 100 }, (_, n) => writeFile(join(source, String(start + n).padStart(5, '0')), '')));
 const channel: VmChannel = {
  exec: async (_name, argv) => { const result = await command(argv, { maxBytes: 16 * 1024 * 1024 }); return { ...result, stdout: result.stdout.slice(-64000) }; },
  push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => copyFile(r, l),
 };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: root, hostTempRoot: join(root, 'temp') });
 const facts = await transfer.scan(source, root); assert.equal(facts.length, 10000); assert.ok(facts.every(f => f.bytes === 0));
 await writeFile(join(source, '10000'), '');
 await assert.rejects(transfer.scan(source, root), /10000 files/);
 assert.deepEqual(await readdir(root), ['temp', 'workspace']); assert.deepEqual(await readdir(join(root, 'temp')), []);
});

test('inventory frame corruption fails closed and cleans both temporary copies', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-frame-bad-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), source = join(guest, 'workspace'), temp = join(root, 'host-temp');
 await mkdir(source, { recursive: true }); await writeFile(join(source, 'a'), 'a');
 const channel: VmChannel = { exec: async (_name, argv) => command(argv), push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => { await copyFile(r, l); await writeFile(l, '[]'); } };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: temp });
 await assert.rejects(transfer.scan(source, guest), /checksum mismatch/);
 assert.deepEqual(await readdir(guest), ['workspace']); assert.deepEqual(await readdir(temp), []);
});

test('approved roots reject symlink ancestors, including changes during extraction and staging', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-ancestors-'))); t.after(() => rm(root, { recursive: true, force: true }));
 const guest = join(root, 'guest'), workspace = join(guest, 'workspace'), outside = join(root, 'outside'), host = join(root, 'host');
 await mkdir(join(workspace, 'nested'), { recursive: true }); await mkdir(outside); await mkdir(host);
 await writeFile(join(outside, 'secret'), 'secret'); await writeFile(join(workspace, 'nested/a'), 'safe');
 const channel: VmChannel = { exec: async (_name, argv) => command(argv), push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => copyFile(r, l) };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: guest, hostTempRoot: join(root, 'temp') });
 await symlink(outside, join(workspace, 'escape'));
 await assert.rejects(transfer.pullVerified(join(workspace, 'escape/secret'), join(host, 'bad'), workspace), /symlink ancestor/);
 await assert.rejects(transfer.pullVerified(join(outside, 'secret'), join(host, 'bad'), workspace), /Path must be inside/);
 await symlink(outside, join(host, 'escape'));
 await assert.rejects(transfer.pushFile(join(host, 'escape/secret'), join(workspace, 'staged'), host), /symlink ancestor/);
 await assert.rejects(transfer.pullVerified(join(workspace, 'nested/a'), join(host, 'escape/overwrite'), workspace, host), /symlink ancestor/);
 await assert.rejects(transfer.pushFile(join(outside, 'secret'), join(workspace, 'escape/overwrite')), /symlink ancestor/);
 channel.pull = async (_name, r, l) => {
  await copyFile(r, l);
  if (r === join(workspace, 'nested/a')) { await rename(join(workspace, 'nested'), join(workspace, 'old')); await symlink(join(workspace, 'old'), join(workspace, 'nested')); }
 };
 await assert.rejects(transfer.pullVerified(join(workspace, 'nested/a'), join(host, 'changed'), workspace), /symlink ancestor/);
 await rm(join(workspace, 'nested')); await rename(join(workspace, 'old'), join(workspace, 'nested'));
 channel.push = async (_name, l, r) => { await copyFile(l, r); await writeFile(l, 'mutated'); };
 await assert.rejects(transfer.pushFile(join(workspace, 'nested/a'), join(workspace, 'staged'), workspace), /Staging source changed/);
});

test('OS symlink ancestors above approved roots remain usable', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-alias-'))); t.after(() => rm(root, { recursive: true, force: true }));
 await mkdir(join(root, 'real/workspace'), { recursive: true }); await symlink(join(root, 'real'), join(root, 'alias'));
 const approved = join(root, 'alias/workspace'); await writeFile(join(approved, 'a'), 'safe');
 const channel: VmChannel = { exec: async (_name, argv) => command(argv), push: async (_name, l, r) => copyFile(l, r), pull: async (_name, r, l) => copyFile(r, l) };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: approved });
 await transfer.pullVerified(join(approved, 'a'), join(root, 'result'), approved);
 assert.equal(await readFile(join(root, 'result'), 'utf8'), 'safe');
});

test('remote inventory rejects over-bound files and special files without carrying their bytes', async t => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-bound-'))); t.after(() => rm(root, { recursive: true, force: true }));
 await writeFile(join(root, 'oversize'), ''); await truncate(join(root, 'oversize'), 512 * 1024 * 1024 + 1);
 const channel: VmChannel = { exec: async (_name, argv) => command(argv), push: async (_name, l, r) => copyFile(l, r), pull: async () => assert.fail('oversize inventory must fail before pull') };
 const transfer = new Transfer(channel, 'fake', process.execPath, { guestRoot: root });
 await assert.rejects(transfer.scan(join(root, 'oversize'), root), /512MiB/);
 await command(['/usr/bin/mkfifo', join(root, 'fifo')]);
 await assert.rejects(transfer.scan(join(root, 'fifo'), root), /special file/);
});

test('path traversal rejected before IO', () => {
 for (const path of ['', '..', '../x', '/elsewhere', 'a\\b', 'a\0b', '.']) assert.throws(() => within('/safe', path));
 assert.equal(within('/safe', 'folder/file'), '/safe/folder/file');
});

test('probe remains read-only; unknown is not no user activity', async () => {
 const called: string[][] = [];
 const unavailable = await probeLocal(async argv => { called.push([...argv]); throw Error('unavailable'); });
 assert.equal(unavailable.screenshot.available, null); assert.equal(unavailable.userSessionActive.value, null);
 assert.match(unavailable.recommendation, /Unknown activity is not proof/);
 assert.ok(called.every(argv => !argv.includes('grant') && !argv.includes('get_desktop_state')));
 const probe = await probeLocal(async argv => {
  const output = argv.includes('permissions') ? JSON.stringify({ screen_recording: true, accessibility: true }) : argv.includes('list_apps') ? '{"apps":[]}' : argv.includes('IOHIDSystem') ? '"HIDIdleTime" = 5000000000' : argv.includes('/dev/console') ? 'root\n' : '{}';
  return { stdout: output, stderr: '', code: 0 };
 }, 'darwin');
 assert.equal(probe.idleSeconds.value, 5); assert.equal(probe.userSessionActive.value, false);
 assert.match(probe.recommendation, /Prefer local tools/);
});

test('local helper bounds output and timeouts', async () => {
 await assert.rejects(command([process.execPath, '-e', "console.log('x'.repeat(1000))"], { maxBytes: 10 }), /output exceeded/);
 await assert.rejects(command([process.execPath, '-e', 'setInterval(()=>{},100)'], { timeoutMs: 10 }), /timed out/);
});
