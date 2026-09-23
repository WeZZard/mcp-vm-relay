import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('package.json, the plugin manifest and the pinned pi-mcp.json arg agree on the version', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const plugin = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8'));
  const piMcp = JSON.parse(await readFile('pi-mcp.json', 'utf8'));
  const pinned = piMcp.mcpServers['vm-relay'].args.find((arg: string) => arg.startsWith('@wezzard/mcp-vm-relay@'));
  assert.ok(pinned, 'pi-mcp.json must pin @wezzard/mcp-vm-relay@<version>');
  assert.equal(plugin.version, pkg.version, '.claude-plugin/plugin.json version must match package.json');
  assert.equal(pinned, `@wezzard/mcp-vm-relay@${pkg.version}`, 'pi-mcp.json must pin the same version as package.json');
});
