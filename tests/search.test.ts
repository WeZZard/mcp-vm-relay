import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCatalog, serializeSearchResult, SEARCH_LIMITS, type SearchResult, type ApplicationCatalog } from '../src/search.js';
const app = (id: string, name = id, aliases: string[] = []) => ({ id, name, aliases, version: '1' });
const catalog = (applications = [app('firefox', 'Firefox', ['Mozilla Firefox'])]): ApplicationCatalog => ({ schemaVersion: 1, images: [{ image: 'ubuntu2404', os: 'linux', architecture: 'arm64', applications }] });
test('name/alias matching trims, folds case, and never substitutes browsers', () => {
  const c = catalog();
  for (const name of [' FIREFOX ', 'mozilla firefox', 'fire', 'irefo']) assert.equal(searchCatalog(c, { name }).applications[0]?.name, 'Firefox');
  assert.deepEqual(searchCatalog(c, { name: 'Chromium' }), { applications: [], truncated: false });
  assert.throws(() => searchCatalog(c, { name: '  ' }), /nonblank/);
});
test('exact then prefix then substring ordering is deterministic and OS is a hard filter', () => {
  const c = catalog([app('3', 'My Firefox'), app('2', 'Firefox Nightly'), app('1', 'Firefox')]);
  assert.deepEqual(searchCatalog(c, { name: 'firefox' }).applications.map(a => a.name), ['Firefox', 'Firefox Nightly', 'My Firefox']);
  assert.deepEqual(searchCatalog(c, { name: 'firefox', os: 'macos' }), { applications: [], truncated: false });
});
test('deduplicates alias hits and installations; rejects contradictory data before filtering', () => {
  const c = catalog([app('f', 'Firefox', ['firefox']), app('f', 'Firefox', ['Mozilla'])]);
  assert.equal(searchCatalog(c, { name: 'firefox' }).applications[0]?.installations.length, 1);
  c.images[0]!.applications[1]!.version = '2';
  assert.throws(() => searchCatalog(c, { name: 'unmatched', os: 'macos' }), /Conflicting/);
});
test('100 installations exactly is complete; 101 returns complete prefix with truncation', () => {
  for (const count of [100, 101]) {
    const c = catalog(Array.from({ length: count }, (_, i) => app(`app${String(i).padStart(3, '0')}`)));
    const result = searchCatalog(c, { name: 'app' });
    assert.equal(result.applications.length, 100);
    assert.equal(result.truncated, count > 100);
    const encoded = serializeSearchResult(result);
    assert.ok(Buffer.byteLength(encoded) <= 50000);
    assert.ok(encoded.split('\n').length <= 1900);
    assert.deepEqual(JSON.parse(encoded), result);
  }
});
test('byte cap accounts for multibyte names, escaping and full records', () => {
  const c = catalog(Array.from({ length: 100 }, (_, i) => app(`app${i}`, 'app' + '界'.repeat(250))));
  const result = searchCatalog(c, { name: 'app' });
  assert.equal(result.truncated, true);
  assert.ok(result.applications.length < 100);
  assert.ok(Buffer.byteLength(serializeSearchResult(result)) <= 50000);
  assert.ok(result.applications.every(a => a.installations.length === 1));
});
test('OS filtering excludes aliases belonging only to another OS', () => {
  const c = catalog([app('f', 'Firefox', ['Linux Browser'])]);
  c.images.push({ image: 'macos26', os: 'macos', architecture: 'arm64', applications: [app('f', 'Firefox', ['Mac Browser'])] });
  assert.deepEqual(searchCatalog(c, { name: 'Linux Browser', os: 'macos' }), { applications: [], truncated: false });
  assert.equal(searchCatalog(c, { name: 'Mac Browser', os: 'macos' }).applications.length, 1);
});
test('ties use Unicode code-point order rather than UTF-16 unit order', () => {
  const c = catalog([app('a', 'app\u{10000}'), app('b', 'app\uE000')]);
  assert.deepEqual(searchCatalog(c, { name: 'app' }).applications.map(a => a.name), ['app\uE000', 'app\u{10000}']);
});
test('record truncation preserves the sorted prefix inside a multi-installation group', () => {
  const c: ApplicationCatalog = { schemaVersion: 1, images: Array.from({ length: 64 }, (_, i) => ({
    image: `image${String(63 - i).padStart(2, '0')}`, os: 'linux', architecture: 'arm64',
    applications: [app('b', 'app B'), app('a', 'app A')],
  })) };
  const result = searchCatalog(c, { name: 'app' });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.applications.map(a => [a.name, a.installations.length]), [['app A', 64], ['app B', 36]]);
  for (const group of result.applications) assert.deepEqual(group.installations.map(i => i.image),
    Array.from({ length: group.installations.length }, (_, i) => `image${String(i).padStart(2, '0')}`));
  assert.deepEqual(JSON.parse(serializeSearchResult(result)), result);
});

test('OS filtering happens before either record or byte truncation', () => {
  const c = catalog(Array.from({ length: 101 }, (_, i) => app(`a${i}`, 'app A' + '界'.repeat(250))));
  c.images.push({ image: 'macos26', os: 'macos', architecture: 'arm64', applications: [app('z', 'app Z')] });
  assert.equal(searchCatalog(c, { name: 'app' }).truncated, true);
  assert.deepEqual(searchCatalog(c, { name: 'app', os: 'macos' }), {
    applications: [{ name: 'app Z', installations: [{ image: 'macos26', version: '1', os: 'macos', architecture: 'arm64' }] }], truncated: false,
  });
});

test('exact UTF-8 byte threshold includes JSON escaping and the false envelope', () => {
  const applications = Array.from({ length: 50 }, (_, i) => ({ ...app(`app${String(i).padStart(2, '0')}`), version: '😀'.repeat(190) + '"\\' }));
  const c = catalog(applications);
  const expected: SearchResult = { applications: applications.map(a => ({ name: a.name, installations: [{ image: 'ubuntu2404', version: a.version, os: 'linux', architecture: 'arm64' }] })), truncated: false };
  let padding = SEARCH_LIMITS.bytes - Buffer.byteLength(serializeSearchResult(expected), 'utf8');
  assert.ok(padding > 0);
  for (let i = 0; i < applications.length && padding; i++) {
    // Reserve one scalar for the over-budget variant below.
    const added = Math.min(padding, 255 - Array.from(applications[i]!.version).length);
    applications[i]!.version += 'x'.repeat(added);
    expected.applications[i]!.installations[0]!.version = applications[i]!.version;
    padding -= added;
  }
  assert.equal(padding, 0, 'fixture can reach the exact budget within validated scalar limits');
  const encoded = serializeSearchResult(expected);
  assert.equal(Buffer.byteLength(encoded, 'utf8'), 50000);
  assert.ok(encoded.includes('\\"') && encoded.includes('\\\\'), 'fixture contains JSON-escaped quote and backslash');
  assert.ok(encoded.length < Buffer.byteLength(encoded), 'UTF-16 length is not the UTF-8 budget');
  assert.deepEqual(searchCatalog(c, { name: 'app' }), expected);
  applications[49]!.version += 'x';
  expected.applications[49]!.installations[0]!.version = applications[49]!.version;
  assert.equal(Buffer.byteLength(serializeSearchResult(expected), 'utf8'), 50001);
  const result = searchCatalog(c, { name: 'app' });
  assert.deepEqual(result, { applications: expected.applications.slice(0, 49), truncated: true });
  assert.ok(Buffer.byteLength(serializeSearchResult(result)) <= 50000);
});

test('validated inputs cannot reach line cap or oversized-first-record branch', () => {
  // C0/newlines are forbidden; JSON strings cannot introduce physical lines.
  // Pretty JSON has 5 envelope lines + 5 per group + 6 per installation.
  // Thus n <= 100, groups <= n gives at most 1105 lines (< 1900).
  const hundred = searchCatalog(catalog(Array.from({ length: 100 }, (_, i) => app(`app${i}`))), { name: 'app' });
  assert.equal(serializeSearchResult(hundred).split('\n').length, 5 + 5 * 100 + 6 * 100);
  assert.ok(1105 < SEARCH_LIMITS.lines);
  // The largest allowed scalar needs 4 UTF-8 bytes; allowed quote/backslash
  // escaping needs only 2. Names/versions <= 256 scalars, image <= 128 ASCII.
  const c: ApplicationCatalog = { schemaVersion: 1, images: [{ image: 'i'.repeat(128), os: 'macos', architecture: 'x86_64', applications: [{ ...app('id', '😀'.repeat(256)), version: '😀'.repeat(256) }] }] };
  const result = searchCatalog(c, { name: '😀' });
  const emptyFields: SearchResult = { applications: [{ name: '', installations: [{ image: '', version: '', os: 'macos', architecture: 'x86_64' }] }], truncated: false };
  const maximumBytes = Buffer.byteLength(serializeSearchResult(emptyFields)) + 2 * 256 * 4 + 128;
  assert.equal(Buffer.byteLength(serializeSearchResult(result)), maximumBytes);
  assert.ok(maximumBytes < SEARCH_LIMITS.bytes);
  assert.equal(result.truncated, false);
  assert.equal(result.applications[0]!.installations.length, 1);
});

test('malformed catalogs are errors, not empty success', () => {
  for (const value of [null, {}, { schemaVersion: 1, images: [], truncated: true }, catalog([{ ...app('x'), version: 12 } as any])]) {
    assert.throws(() => searchCatalog(value, { name: 'x' }), /catalog/);
  }
});
