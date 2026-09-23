import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('package.json, the plugin manifest and the pinned pi-mcp.json arg agree on the version', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const plugin = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8'));
  const piMcp = JSON.parse(await readFile('pi-mcp.json', 'utf8'));
  const pinned = piMcp.mcpServers['relay'].args.find((arg: string) => arg.startsWith('@wezzard/mcp-vm-relay@'));
  assert.ok(pinned, 'pi-mcp.json must pin @wezzard/mcp-vm-relay@<version>');
  assert.equal(plugin.version, pkg.version, '.claude-plugin/plugin.json version must match package.json');
  assert.equal(pinned, `@wezzard/mcp-vm-relay@${pkg.version}`, 'pi-mcp.json must pin the same version as package.json');
});

test('package.json no longer ships skills or a hook, and relies on MCP alone', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(!pkg.files.some((entry: string) => entry.startsWith('skills') || entry.startsWith('hooks')), JSON.stringify(pkg.files));
  assert.deepEqual(pkg.pi, { mcp: './pi-mcp.json' });
});

test('npm pack ships no skills/ or hooks/ files', async () => {
  const { stdout } = await run('npm', ['pack', '--dry-run', '--json']);
  // npm 10 prints an array of packages; npm 12 prints an object keyed by package name.
  const parsed = JSON.parse(stdout);
  const { files } = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0] as { files: { path: string }[] };
  const paths = files.map((file: { path: string }) => file.path);
  assert.ok(!paths.some((path: string) => path.startsWith('skills/') || path.startsWith('hooks/')), JSON.stringify(paths));
});
