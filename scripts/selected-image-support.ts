// Offline byte/provenance checks only. Never execute the retained ELF on the host.
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { assertHostPath } from '../src/transfer.js';
export const DRIVER_SHA256 = '85562bf19647b44a3c970cad8149d4eb1523291d22327641c3caea536a636f7a';
export const DRIVER_BYTES = 46421584;
export const historicalPackage = 'test-evidence/ubuntu-key-backed-acceptance-20260913-031124/packages/relay-relay-smoke-ubuntu-d5d13580';
export const historicalEvent = 'host/events/1789269277594-50a2dbfe-62be-4eb5-af18-7df078cd290c.json';
export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export function supportArgument(args: string[]) {
  const positions = args.flatMap((v,i)=>v==='--support-driver'?[i]:[]);
  assert(positions.length <= 1, 'Duplicate --support-driver');
  if (!positions.length) return undefined;
  const value=args[positions[0]!+1];
  assert(value && !value.startsWith('--'), '--support-driver requires a local path');
  return resolve(value);
}
export async function verifySupportDriver(project: string, local: string) {
  await assertHostPath(dirname(local), local);
  assert((await lstat(local)).isFile(), 'Driver must be a regular file');
  const bytes=await readFile(local);
  assert.equal(bytes.length, DRIVER_BYTES);
  assert.equal(sha256(bytes), DRIVER_SHA256, 'Driver differs from retained acceptance artifact');
  assert.equal(bytes.subarray(0,6).toString('hex'), '7f454c460201');
  assert.equal(bytes.readUInt16LE(18), 183, 'ELF must be AArch64');
  const packageRoot=join(project,historicalPackage);
  const manifestBytes=await readFile(join(packageRoot,'manifest.json'));
  const manifest=JSON.parse(manifestBytes.toString());
  const eventBytes=await readFile(join(packageRoot,historicalEvent));
  const record=manifest.records.find((r:any)=>r.path===historicalEvent);
  assert(record, 'Historical stage event missing from manifest');
  assert.equal(record.sha256,sha256(eventBytes)); assert.equal(record.bytes,eventBytes.length);
  const fact=JSON.parse(eventBytes.toString()).details.find((r:any)=>r.remote.endsWith('/support/cua-driver'));
  assert.equal(fact.sha256,DRIVER_SHA256); assert.equal(fact.bytes,DRIVER_BYTES);
  const versionPath='test-evidence/ubuntu-20260912-2127/results/005.json';
  const versionBytes=await readFile(join(project,versionPath));
  assert(JSON.parse(versionBytes.toString()).result.output.includes('cua-driver 0.26.0'));
  return {bytes, provenance:{local,sha256:DRIVER_SHA256,bytes:DRIVER_BYTES,format:'ELF64 little-endian AArch64',historicalPackage,historicalEvent,manifestSha256:sha256(manifestBytes),eventSha256:sha256(eventBytes),historicalFact:fact,versionRecord:{path:versionPath,sha256:sha256(versionBytes)},versionEvidence:'test-evidence/ubuntu-20260912-2127/results/005.json: guest output cua-driver 0.26.0; upstream release/commit not independently authenticated'}};
}
