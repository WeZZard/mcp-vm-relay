import { Type, StringEnum } from './typebox.js';
import { Check } from 'typebox/value';
import type { Static } from 'typebox';

const closed = { additionalProperties: false };
// Explicit ECMAScript whitespace; do not use language-dependent blank tests.
const whitespace = '\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
// TypeBox uses UTF-16 lengths. Scalar bounds are enforced in validateCatalog.
// Accept paired UTF-16 surrogates only, even when compiled without the u flag.
const text = () => Type.String({ minLength: 1, pattern: `^(?![${whitespace}]*$)(?:[^\\u0000-\\u001f\\ud800-\\udfff]|[\\ud800-\\udbff][\\udc00-\\udfff])+(?![\\s\\S])` });
const application = Type.Object({
  id: text(), name: text(), aliases: Type.Array(text(), { maxItems: 16 }),
  version: Type.Union([text(), Type.Null()]),
}, closed);
export const catalogSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  images: Type.Array(Type.Object({
    image: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?![\\s\\S])' }),
    os: StringEnum(['linux', 'macos'] as const),
    architecture: StringEnum(['arm64', 'x86_64'] as const),
    applications: Type.Array(application, { maxItems: 20000 }),
  }, closed), { maxItems: 64 }),
}, closed);
export type ApplicationCatalog = Static<typeof catalogSchema>;
export interface SearchQuery { name: string; os?: 'linux' | 'macos' }
export interface Installation { image: string; version: string | null; os: 'linux' | 'macos'; architecture: string }
export interface SearchResult { applications: Array<{ name: string; installations: Installation[] }>; truncated: boolean }
export const SEARCH_LIMITS = Object.freeze({ installations: 100, bytes: 50000, lines: 1900 });
const compare = (a: string, b: string) => {
  const left = Array.from(a, c => c.codePointAt(0)!);
  const right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
};
export const normalizeSearchName = (name: string) => name.trim().toLowerCase();
export const serializeSearchResult = (result: SearchResult) => JSON.stringify(result, null, 2);

export function validateCatalog(value: unknown): asserts value is ApplicationCatalog {
  if (!Check(catalogSchema, value)) throw new Error('Invalid application catalog schema');
  const bounded = (text: string, limit: number) => {
    if (Array.from(text).length > limit) throw new Error('Application catalog exceeds text limit');
  };
  for (const image of value.images) for (const app of image.applications) {
    bounded(app.id, 128);
    bounded(app.name, 256);
    for (const alias of app.aliases) bounded(alias, 256);
    if (app.version !== null) bounded(app.version, 256);
  }
  if (value.images.reduce((n, image) => n + image.applications.length, 0) > 20000) throw new Error('Application catalog exceeds installation limit');
}

/** Pure matching: never touches a VM, registry, filesystem or lifecycle state. */
export function searchCatalog(value: unknown, query: SearchQuery): SearchResult {
  if (typeof query.name !== 'string' || !query.name.trim()) throw new Error('Search name must be nonblank');
  if (query.os !== undefined && query.os !== 'linux' && query.os !== 'macos') throw new Error('Invalid search OS');
  validateCatalog(value);
  const needle = normalizeSearchName(query.name);
  const groups = new Map<string, { name: string; aliases: Set<string>; installations: Map<string, Installation> }>();
  const imageFacts = new Map<string, string>();
  for (const image of value.images) {
    const facts = `${image.os}/${image.architecture}`;
    if (imageFacts.has(image.image) && imageFacts.get(image.image) !== facts) throw new Error('Conflicting catalog image facts');
    imageFacts.set(image.image, facts);
    for (const app of image.applications) {
      let group = groups.get(app.id);
      if (!group) { group = { name: app.name, aliases: new Set(), installations: new Map() }; groups.set(app.id, group); }
      if (group.name !== app.name) throw new Error('Conflicting canonical application names');
      if (!query.os || image.os === query.os) for (const alias of app.aliases) group.aliases.add(alias);
      const installation: Installation = { image: image.image, version: app.version, os: image.os, architecture: image.architecture };
      const previous = group.installations.get(image.image);
      if (previous && JSON.stringify(previous) !== JSON.stringify(installation)) throw new Error('Conflicting application installation facts');
      group.installations.set(image.image, installation);
    }
  }
  const matches = [...groups].flatMap(([id, group]) => {
    const installations = [...group.installations.values()].filter(i => !query.os || i.os === query.os).sort((a, b) => compare(a.image, b.image));
    if (!installations.length) return [];
    let rank = 3;
    for (const name of [group.name, ...group.aliases]) {
      const candidate = name.toLowerCase();
      rank = Math.min(rank, candidate === needle ? 0 : candidate.startsWith(needle) ? 1 : candidate.includes(needle) ? 2 : 3);
      if (rank === 0) break;
    }
    return rank === 3 ? [] : [{ id, name: group.name, rank, installations }];
  }).sort((a, b) => a.rank - b.rank || compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.name, b.name) || compare(a.id, b.id));
  const result: SearchResult = { applications: [], truncated: false };
  let count = 0;
  for (const match of matches) {
    const group: SearchResult['applications'][number] = { name: match.name, installations: [] };
    result.applications.push(group);
    for (const installation of match.installations) {
      group.installations.push(installation);
      const serialized = serializeSearchResult(result);
      if (count === SEARCH_LIMITS.installations || Buffer.byteLength(serialized) > SEARCH_LIMITS.bytes || serialized.split('\n').length > SEARCH_LIMITS.lines) {
        group.installations.pop();
        if (!group.installations.length) result.applications.pop();
        result.truncated = true;
        return result;
      }
      count++;
    }
  }
  return result;
}
