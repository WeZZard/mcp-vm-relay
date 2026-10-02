import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DownloadQueue, type DownloadJob } from '../src/downloads.js';
import type { ImageResult } from '../src/images.js';

/** A download the test ends by hand, so it can observe the queue between steps. */
function gate() {
  let end!: (result: ImageResult) => void;
  const ended = new Promise<ImageResult>(resolve => { end = resolve; });
  let started = false, signal: AbortSignal | undefined;
  const run = (s: AbortSignal) => { started = true; signal = s; return Promise.race([ended, new Promise<ImageResult>(resolve => s.addEventListener('abort', () => resolve({ status: 'transfer-failed', diagnostic: 'aborted' }), { once: true }))]); };
  return { run, end, get started() { return started; }, get signal() { return signal; } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const downloaded: ImageResult = { status: 'downloaded' };
const transient: ImageResult = { status: 'transfer-failed', diagnostic: 'connection lost' };
function queue(bound = 64) {
  const records: Array<Pick<DownloadJob, 'key' | 'end'>> = [];
  const q = new DownloadQueue({ bound, record: async job => { records.push({ key: job.key, end: job.end }); } });
  const add = (key: string) => { const g = gate(); return { ...g, job: q.enqueue({ key, recordPath: `/unused/${key}` }, g.run), gate: g }; };
  return { q, records, add };
}

test('one worker takes downloads in order and records each as it ends', async () => {
  const { q, records, add } = queue();
  const a = add('a'), b = add('b');
  assert.equal(a.gate.started, true); assert.equal(b.gate.started, false);
  assert.equal(q.pending, 2);
  a.gate.end(downloaded); await a.job.done;
  assert.equal(b.gate.started, true);
  b.gate.end({ status: 'integrity-failed', diagnostic: 'hash mismatch' }); await b.job.done;
  assert.deepEqual(records, [{ key: 'a', end: 'downloaded' }, { key: 'b', end: 'failed' }]);
  assert.deepEqual(q.counts(), { queued: 0, inFlight: 0, downloaded: 1, failed: 1, cancelled: 0, paused: false, state: 'open' });
});

test('a lasting failure does not pause the worker; a transient one does, until an operation completes (AD-4)', async () => {
  const { q, add } = queue();
  const a = add('a'), b = add('b'), c = add('c');
  a.gate.end({ status: 'integrity-failed' }); await a.job.done;
  assert.equal(q.paused, false); assert.equal(b.gate.started, true, 'a lasting failure is not retried and the worker goes on');
  b.gate.end(transient); await b.job.done; await tick();
  assert.equal(q.paused, true); assert.equal(c.gate.started, false, 'the worker waits after a transient failure');
  q.resume();
  assert.equal(c.gate.started, true);
});

test('relay_image runs the download it names next, even while the worker is paused, and its success lifts the pause (AD-3)', async () => {
  const { q, add } = queue();
  const a = add('a'), b = add('b'), c = add('c');
  a.gate.end(transient); await a.job.done; await tick();
  assert.equal(q.paused, true);
  q.promote(c.job);
  assert.equal(c.gate.started, true, 'the named download runs ahead of the queue'); assert.equal(b.gate.started, false);
  c.gate.end(downloaded); await c.job.done;
  assert.equal(q.paused, false); assert.equal(b.gate.started, true);
  assert.equal(q.find({ key: 'b' }), b.job); assert.equal(q.find({ key: 'c' }), undefined, 'an ended download is no longer found');
});

test('a promotion made while a failing download records its end is not lost', async () => {
  const { q, add } = queue();
  const a = add('a'), b = add('b');
  a.gate.end(transient); q.promote(b.job); await a.job.done; await tick();
  assert.equal(b.gate.started, true);
});

test('over the bound a run waits for the oldest download, but not while the worker is paused (AD-2)', async () => {
  const { q, add } = queue(1);
  const a = add('a'); add('b');
  let waited = false; const within = q.withinBound().then(() => { waited = true; });
  await tick(); assert.equal(waited, false);
  a.gate.end(downloaded); await within; assert.equal(waited, true);
  const { q: paused, add: addPaused } = queue(1);
  const p = addPaused('p'); addPaused('q'); addPaused('r');
  p.gate.end(transient); await p.job.done; await tick();
  assert.equal(paused.paused, true);
  await paused.withinBound();
});

test('drain lifts the pause, waits for every download, and reopens; while closing a transient failure cancels the rest (AD-5, DC-7)', async () => {
  const { q, records, add } = queue();
  const a = add('a'), b = add('b');
  a.gate.end(transient); await a.job.done; await tick();
  assert.equal(q.paused, true);
  let drained = false; const draining = q.drain().then(() => { drained = true; });
  assert.equal(q.state, 'closing'); assert.equal(b.gate.started, true, 'the operation needs the guest, so it lifts the pause');
  assert.throws(() => q.enqueue({ key: 'late', recordPath: '/unused' }, async () => downloaded), /closing/);
  b.gate.end(downloaded); await draining; assert.equal(drained, true);
  q.reopen(); assert.equal(q.state, 'open');
  const c = add('c'), d = add('d'), e = add('e');
  const second = q.drain();
  c.gate.end(transient); await second;
  assert.equal(d.gate.started, false); assert.equal(e.gate.started, false);
  assert.deepEqual(records.slice(-3), [{ key: 'c', end: 'failed' }, { key: 'd', end: 'cancelled' }, { key: 'e', end: 'cancelled' }], 'each cancelled download is recorded before drain returns');
  assert.equal(q.counts().cancelled, 2);
  q.reopen();
});

test('close aborts the download in flight, drops the queue and writes nothing more', async () => {
  const { q, records, add } = queue();
  const a = add('a'), b = add('b');
  await q.close(true);
  assert.equal(a.gate.signal?.aborted, true); assert.equal(b.gate.started, false);
  assert.deepEqual(records, [], 'a closed queue records nothing');
  assert.equal(q.state, 'closed');
  await q.drain(); q.reopen(); assert.equal(q.state, 'closed', 'a closed queue does not reopen');
  assert.throws(() => q.enqueue({ key: 'c', recordPath: '/unused' }, async () => downloaded), /closed/);
});
