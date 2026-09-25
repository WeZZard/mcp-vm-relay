import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Strict YAML parsers (pi's among them) reject a plain scalar containing ": ",
// and pi then drops the whole file. Such values must be quoted.
const files = ['agents', 'commands', 'pi-prompts'].flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.md')).map(name => join(dir, name)));
for (const file of files) {
  test(`${file} frontmatter values are valid plain or quoted YAML scalars`, () => {
    const [, frontmatter] = readFileSync(file, 'utf8').split(/^---$/m);
    for (const line of frontmatter.trim().split('\n')) {
      const value = line.slice(line.indexOf(':') + 1).trim();
      if (value.startsWith('"') || value.startsWith("'")) continue;
      assert.ok(!value.includes(': ') && !value.endsWith(':'), `${file}: quote the value of "${line.split(':')[0]}"`);
    }
  });
}
