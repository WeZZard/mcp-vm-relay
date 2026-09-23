import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { doctrine, relayActions, relayJsonSchema, relayToolDescription } from '../src/core.js';
import type { RelayManager } from '../src/manager.js';
import { PLUGIN_TOOL_PREFIX, REVIEW_TOOL, STATUS_TOOL, createRelayServer, doctrineText, projectDirectory, relayContent, relayInputSchema } from '../src/server.js';

const run = promisify(execFile);
const server = resolve('dist/server.mjs');

test('the offered schema is the relay contract without its root anyOf; the strict branches stay in the core', () => {
  const offered = relayInputSchema(), strict = relayJsonSchema();
  assert.equal('anyOf' in offered, false); assert.equal((strict.anyOf as unknown[]).length, 17);
  assert.deepEqual(((offered.properties as any).target.anyOf as any[]).map(b => b.properties.source.const), ['display', 'application', 'reference'], 'the image selector keeps its closed branches inside the projected object');
  assert.deepEqual((offered.properties as any).action.enum, [...relayActions]);
  assert.deepEqual(Object.keys(offered.properties as object), Object.keys(strict.properties as object));
  assert.equal(offered.additionalProperties, false);
});

test('the project directory comes from the plugin, unless the placeholder was never expanded', () => {
  assert.equal(projectDirectory({ MCP_VM_RELAY_PROJECT: '/tmp/project' }, '/elsewhere'), '/tmp/project');
  assert.equal(projectDirectory({ MCP_VM_RELAY_PROJECT: '${CLAUDE_PROJECT_DIR}' }, '/elsewhere'), '/elsewhere');
  assert.equal(projectDirectory({}, '/elsewhere'), '/elsewhere');
});

test('the hook prints the relay doctrine and the names this runtime gives the tools', async () => {
  const { stdout } = await run(process.execPath, [server, '--doctrine']);
  assert.equal(stdout, `${doctrineText()}\n`);
  assert.ok(stdout.startsWith(doctrine));
  assert.match(stdout, new RegExp(`${PLUGIN_TOOL_PREFIX}relay`));
  const schema = JSON.parse((await run(process.execPath, [server, '--schema'])).stdout);
  assert.deepEqual(schema, relayInputSchema());
  await assert.rejects(run(process.execPath, [server, '--nonsense']), /Usage/);
});

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-vm-relay-')));
  const project = join(root, 'project'); await mkdir(project);
  t.after(() => rm(root, { recursive: true, force: true }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: {
    ...process.env as Record<string, string>,
    MCP_VM_RELAY_PROJECT: project, MCP_VM_RELAY_SESSION: 'test-session',
    HOME: root, // no ~/AGENTS.md here: the relay keeps a private registry in its own state directory
    MCP_VM_RELAY_STATE_DIR: join(root, 'state'),
    MCP_VM_RELAY_URL: 'http://127.0.0.1:9', // nothing listens: every service call fails fast and visibly
  } });
  const client = new Client({ name: 'mcp-vm-relay-test', version: '0' });
  await client.connect(transport);
  t.after(() => client.close());
  return { root, project, client };
}

test('over stdio the server offers the relay tool with the core description, plus the two operator tools', async t => {
  const { client } = await fixture(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['relay', STATUS_TOOL, REVIEW_TOOL]);
  assert.equal(tools[0]!.description, relayToolDescription);
  assert.deepEqual(tools[0]!.inputSchema, relayInputSchema());
  assert.deepEqual(tools[1]!.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
});

test('invalid input is refused by the strict contract before any manager exists; status stays inactive', async t => {
  const { client, root, project } = await fixture(t);
  for (const args of [{ action: 'dance' }, { action: 'run', kind: 'exec', argv: ['node'] }, { action: 'probe', reason: 'no' }, {}]) {
    const result: any = await client.callTool({ name: 'relay', arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, /Invalid relay input/);
  }
  const status: any = await client.callTool({ name: STATUS_TOOL, arguments: {} });
  assert.equal(status.isError, false); assert.deepEqual(JSON.parse(status.content[0].text), { active: false, project, service: 'http://127.0.0.1:9' });
  await assert.rejects(stat(join(root, 'state')), { code: 'ENOENT' }); // nothing was created for refused calls
});

test('a valid call that reaches an unreachable service is an error result, not a crash', async t => {
  const { client } = await fixture(t);
  const result: any = await client.callTool({ name: 'relay', arguments: { action: 'search', name: 'Firefox' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /vm-service \/applications: request failed/);
  const status: any = await client.callTool({ name: STATUS_TOOL, arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).active, false);
});

test('review refuses an absent or unverified package and never opens a browser for it', async t => {
  const { client, project } = await fixture(t);
  const missing: any = await client.callTool({ name: REVIEW_TOOL, arguments: { directory: 'no-such-package' } });
  assert.equal(missing.isError, true);
  await mkdir(join(project, 'bad-package'));
  const bad: any = await client.callTool({ name: REVIEW_TOOL, arguments: { directory: 'bad-package' } });
  assert.equal(bad.isError, true);
  const blank: any = await client.callTool({ name: REVIEW_TOOL, arguments: {} });
  assert.equal(blank.isError, true); assert.match(blank.content[0].text, /directory is required/);
  const unknown: any = await client.callTool({ name: 'relay_dance', arguments: {} });
  assert.equal(unknown.isError, true);
});

test('cancelling a relay call from the client aborts the server-side signal', async t => {
  let capturedSignal: AbortSignal | undefined;
  let started: () => void;
  const ran = new Promise<void>(resolve => { started = resolve; });
  const fakeManager = {
    run: async (_input: unknown, signal?: AbortSignal) => {
      capturedSignal = signal;
      started();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('run aborted')));
      });
    },
  } as unknown as RelayManager;
  const relay = createRelayServer({ project: '/tmp', manager: () => fakeManager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await relay.server.connect(serverTransport);
  t.after(() => relay.server.close());
  const client = new Client({ name: 'mcp-vm-relay-cancel-test', version: '0' });
  await client.connect(clientTransport);
  t.after(() => client.close());

  const controller = new AbortController();
  const step = { id: 'step', title: 'Fixture', expected: 'Completes', inputMode: 'ordinary' };
  const callPromise = client.callTool(
    { name: 'relay', arguments: { action: 'run', reason: 'Exercise client-initiated cancellation', kind: 'exec', argv: ['node', '--version'], step, snapshots: { afterIntervalMs: 0 } } },
    undefined,
    { signal: controller.signal },
  );
  await ran;
  assert.equal(capturedSignal?.aborted, false);
  controller.abort();
  await assert.rejects(callPromise);
  assert.equal(capturedSignal?.aborted, true);
});

test('the plugin files name the server the tests spoke to and ship the built bundles', async () => {
  const mcp = JSON.parse(await readFile('.mcp.json', 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['vm-relay']);
  assert.deepEqual(mcp.mcpServers['vm-relay'].args, ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs']);
  const plugin = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8'));
  assert.equal(plugin.name, 'mcp-vm-relay');
  assert.equal(PLUGIN_TOOL_PREFIX, `mcp__plugin_${plugin.name}_vm-relay__`);
  const agent = await readFile('agents/vm-relay-operator.md', 'utf8');
  assert.match(agent, new RegExp(`tools: ${PLUGIN_TOOL_PREFIX}relay, ${PLUGIN_TOOL_PREFIX}${STATUS_TOOL}`));
  const hooks = JSON.parse(await readFile('hooks/hooks.json', 'utf8'));
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /--doctrine/);
  for (const name of ['server.mjs', 'receiver.mjs', 'browser.mjs', 'doctor.mjs', 'integrity.json', 'build-info.json', 'NOTICE.txt']) assert.ok((await stat(join('dist', name))).isFile(), name);
  const bundle = await readFile('dist/server.mjs', 'utf8');
  assert.doesNotMatch(bundle, /@earendil-works/);
  const info = JSON.parse(await readFile('dist/build-info.json', 'utf8'));
  assert.deepEqual(info.packages.map((p: any) => p.name).sort(), ['@wezzard/relay-driver-core', '@wezzard/relay-driver-host-sdk', '@wezzard/relay-driver-remote-runtime']);
});

test('an image-bearing relay result becomes MCP content: the text block, then the typed image block, with the error flag preserved', () => {
  const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
  assert.deepEqual(relayContent({ text: 'identity\n{}', details: {}, isError: false, image }), { content: [{ type: 'text', text: 'identity\n{}' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: false });
  assert.deepEqual(relayContent({ text: 'failed', details: {}, isError: true, image }), { content: [{ type: 'text', text: 'failed' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: true });
  assert.deepEqual(relayContent({ text: '{}', details: {}, isError: false }), { content: [{ type: 'text', text: '{}' }], isError: false });
});
