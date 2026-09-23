import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join, resolve, parse } from 'node:path';
import { hash, jsonFile } from './util.js';
import { normalizeSearchName, serializeSearchResult, type SearchQuery, type SearchResult } from './search.js';
import { Type, StringEnum } from './typebox.js';
import { Check } from 'typebox/value';

const common = {
  schemaVersion: Type.Literal(1),
  id: Type.String({ pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' }),
  at: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
  toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  query: Type.Object({ name: Type.String({ minLength: 1, maxLength: 768 }), os: Type.Optional(StringEnum(['linux', 'macos'] as const)) }, { additionalProperties: false }),
};
const diagnosticSchema = Type.Union([
  Type.Object({ ...common, status: Type.Literal('success'), truncated: Type.Boolean(),
    applications: Type.Integer({ minimum: 0, maximum: 100 }), installations: Type.Integer({ minimum: 0, maximum: 100 }),
    bytes: Type.Integer({ minimum: 1, maximum: 50000 }), lines: Type.Integer({ minimum: 1, maximum: 1900 }),
    resultSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  }, { additionalProperties: false }),
  Type.Object({ ...common, status: Type.Literal('error'), error: Type.Literal('Application discovery failed; inspect the tool failure for details.') }, { additionalProperties: false }),
]);

function validDiagnostic(value: any): boolean {
  if (!Check(diagnosticSchema, value)) return false;
  if (!value.query.name || value.query.name !== normalizeSearchName(value.query.name)) return false;
  return value.status !== 'success' || (value.applications <= value.installations
    && (value.applications === 0) === (value.installations === 0));
}

const RECORD = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9-]{36}\.json$/;
/** No owner initialization or recovery: only a private diagnostic tree is touched. */
async function privateDirectory(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe search diagnostic directory');
  }
  const info = await lstat(absolute);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Search diagnostic directory must be private and owned by this user');
}

export async function recordSearch(root: string, query: SearchQuery, outcome: { result: SearchResult } | { error: unknown }, options: { toolCallId?: string; now?: Date } = {}) {
  const directory = join(root, 'search-diagnostics');
  await privateDirectory(root);
  await privateDirectory(directory);
  const now = options.now ?? new Date();
  const id = randomUUID();
  const record: Record<string, unknown> = {
    schemaVersion: 1, id, at: now.toISOString(),
    ...(options.toolCallId ? { toolCallId: options.toolCallId.slice(0, 512) } : {}),
    query: { name: normalizeSearchName(query.name), ...(query.os ? { os: query.os } : {}) },
  };
  if ('result' in outcome) {
    const encoded = serializeSearchResult(outcome.result);
    Object.assign(record, { status: 'success', truncated: outcome.result.truncated,
      applications: outcome.result.applications.length,
      installations: outcome.result.applications.reduce((n, app) => n + app.installations.length, 0),
      bytes: Buffer.byteLength(encoded), lines: encoded.split('\n').length, resultSha256: hash(encoded) });
  } else Object.assign(record, { status: 'error', error: 'Application discovery failed; inspect the tool failure for details.' });
  if (!validDiagnostic(record)) throw new Error('Invalid search diagnostic record');
  if (Buffer.byteLength(JSON.stringify(record, null, 2)) > 16384) throw new Error('Search diagnostic exceeds record limit');
  const entries = await readdir(directory);
  // Validate all entries before pruning anything; do not delete foreign files.
  const existing: Array<{ name: string; at: number }> = [];
  for (const name of entries) {
    if (!RECORD.test(name)) throw new Error('Unrecognized search diagnostic entry');
    const path = join(directory, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe search diagnostic record');
    const previous = JSON.parse(await readFile(path, 'utf8'));
    const at = Date.parse(previous.at);
    if (!validDiagnostic(previous) || !Number.isFinite(at) || new Date(at).toISOString() !== previous.at || previous.query.name !== normalizeSearchName(previous.query.name) || name !== `${previous.at.replace(/:/g, '-')}-${previous.id}.json`) throw new Error('Invalid search diagnostic record');
    existing.push({ name, at });
  }
  existing.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const cutoff = now.getTime() - 30 * 86400000;
  while (existing.length && (existing.length >= 256 || existing[0]!.at < cutoff)) {
    await unlink(join(directory, existing.shift()!.name));
  }
  const path = join(directory, `${now.toISOString().replace(/:/g, '-')}-${id}.json`);
  await jsonFile(path, record);
  return { path, id };
}
