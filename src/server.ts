/**
 * mcp-vm-relay: the Model Context Protocol front end of the VM relay.
 *
 * Everything the relay does lives in mcp-vm-relay's host-agnostic core (the
 * manager, the vm-service client, the registry, the strict contract, the
 * action dispatch and the bounded result rendering). This file binds that
 * core to MCP over standard input and output: nineteen `relay_*` tools, each
 * with its own schema, title and annotations, plus two MCP prompts (`status`
 * and `trajectory`) for the user commands. The server relies on MCP alone:
 * there is no skill, no hook and no agent-runtime-specific delivery path.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RelayManager, Registry, instructions, relayCall, relayToolInput, relayToolInputSchema, relayTools, selectedEnvironment, verifyDeliveredPackage, type RelayCallResult, type RelayToolAnnotations } from './core.js';

export const SERVER_NAME = 'relay';
/** The build injects this from package.json (esbuild define); under tsx it falls back to reading the file directly. */
declare const __MCP_VM_RELAY_VERSION__: string;
export const SERVER_VERSION = typeof __MCP_VM_RELAY_VERSION__ !== 'undefined' ? __MCP_VM_RELAY_VERSION__
  : (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
export const STATUS_TOOL = 'relay_status';
export const TRAJECTORY_TOOL = 'relay_trajectory';
/** How the plugin's MCP server names its tools once Claude Code scopes them. */
export const PLUGIN_TOOL_PREFIX = 'mcp__plugin_mcp-vm-relay_relay__';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], isError });
/** A relay result as MCP content: the relay's text, then (for relay_run) the target tool's own text and images, then the delivered after-snapshot as its own typed block when there is one. */
export function relayContent(result: RelayCallResult) {
  const passthrough = (result.content ?? []).map(block => block.type === 'text' ? { type: 'text' as const, text: block.text } : { type: 'image' as const, data: block.data, mimeType: block.mimeType });
  return { content: [{ type: 'text' as const, text: result.text }, ...passthrough, ...(result.image ? [{ type: 'image' as const, data: result.image.data, mimeType: result.image.mimeType }] : [])], isError: result.isError };
}

/** The project directory: the plugin passes Claude Code's; an unexpanded placeholder or nothing means the server's own working directory. */
export function projectDirectory(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const given = env.MCP_VM_RELAY_PROJECT;
  return given && !given.includes('${') ? resolve(given) : cwd;
}

const readOnlyStatus: RelayToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const trajectoryAnnotations: RelayToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const statusToolDefinition = {
  name: STATUS_TOOL,
  title: 'Show relay status',
  description: 'Show this session\'s owned VM lease (backend binding, guest state, renewal, console observation, last error), staging state and evidence path, plus the project directory, the VM service origin and the selected environment in use; active:false when nothing is owned. Read-only; it does not touch the VM.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: readOnlyStatus,
};
const trajectoryToolDefinition = {
  name: TRAJECTORY_TOOL,
  title: 'Open the trajectory viewer',
  description: 'Verify a delivered relay evidence package (every artifact, hash and reference) and open its trajectory viewer in the local browser. Human review remains pending.',
  inputSchema: { type: 'object', properties: { directory: { type: 'string', description: 'The package directory, absolute or relative to the project.' } }, required: ['directory'], additionalProperties: false },
  annotations: trajectoryAnnotations,
};
/** Every MCP tool this server offers, for `tools/list` and `--schema`. */
function allToolDefinitions() {
  return [
    ...relayTools.map(tool => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: relayToolInputSchema(tool), annotations: tool.annotations })),
    statusToolDefinition, trajectoryToolDefinition,
  ];
}

export interface RelayServerOptions { sessionId?: string; project?: string; open?: (url: string) => Promise<void>; manager?: () => RelayManager }

async function openInBrowser(url: string): Promise<void> {
  const run = promisify(execFile);
  if (process.platform === 'darwin') await run('/usr/bin/open', ['-a', 'Google Chrome', url]);
  else await run('xdg-open', [url]);
}

export function createRelayServer(options: RelayServerOptions = {}) {
  const sessionId = options.sessionId ?? process.env.MCP_VM_RELAY_SESSION ?? randomUUID();
  const project = options.project ?? projectDirectory();
  let manager: RelayManager | undefined;
  // A selected environment (VM_ENVIRONMENT_FILE) binds the backend, the image
  // store and the state directories together; it is resolved once, at the
  // first call, so an invalid selection is reported rather than falling back.
  // Tests inject options.manager directly instead of a real RelayManager.
  const get = options.manager ?? (() => {
    if (!manager) {
      const environment = selectedEnvironment();
      manager = new RelayManager({ sessionId, project, environment, registry: new Registry(environment ? { managedRoot: environment.profile.relayStateDir } : {}) });
    }
    return manager;
  });
  /** The same data relay_status reports and the `status` prompt reads, read-only. */
  const statusPayload = () => {
    const environment = selectedEnvironment();
    const service = environment?.profile.vmServiceUrl ?? process.env.MCP_VM_RELAY_URL ?? 'http://localhost:6240';
    return { ...(manager ? manager.status() : { active: false }), project, service, environment: environment?.identity };
  };
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {}, prompts: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allToolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === STATUS_TOOL) return text(JSON.stringify(statusPayload(), null, 2));
      if (name === TRAJECTORY_TOOL) {
        const directory = (args as { directory?: unknown } | undefined)?.directory;
        if (typeof directory !== 'string' || !directory.trim()) throw new Error('directory is required');
        const root = resolve(project, directory.trim());
        const verified = await verifyDeliveredPackage(root);
        if (!verified.deliveryVerified) throw new Error(`Package failed verification; refusing to open viewer: ${JSON.stringify(verified)}`);
        await (options.open ?? openInBrowser)(pathToFileURL(join(root, 'index.html')).href);
        return text(`Opened verified package: ${root}. Human review remains pending.`);
      }
      if (relayTools.some(tool => tool.name === name)) return relayContent(await relayCall(get, relayToolInput(name, (args ?? {}) as Record<string, unknown>), { signal: extra.signal, toolCallId: String(extra.requestId) }));
      throw new Error(`Unknown tool: ${name}`);
    } catch (error) { return text(message(error), true); }
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      { name: 'status', title: 'Relay status', description: 'Report this session\'s owned VM lease exactly as the relay_status tool sees it. Read-only.' },
      {
        name: 'trajectory', title: 'Relay trajectory', description: 'Ask the assistant to verify a delivered relay evidence package and open its trajectory viewer; human review remains pending.',
        arguments: [{ name: 'directory', description: 'The package directory, absolute or relative to the project.', required: true }],
      },
    ],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    if (name === 'status') {
      return {
        description: 'This session\'s owned VM lease, read-only.',
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Report this exactly as it is, without acting on it:\n${JSON.stringify(statusPayload(), null, 2)}` } }],
      };
    }
    if (name === 'trajectory') {
      const directory = args?.directory;
      if (typeof directory !== 'string' || !directory.trim()) throw new Error('directory is required');
      return {
        description: 'Verify and open a delivered relay evidence package.',
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Call ${TRAJECTORY_TOOL} with directory "${directory}" and report its answer as given. Opening the viewer does not mean the work was approved: human review remains pending until the user says otherwise.` } }],
      };
    }
    throw new Error(`Unknown prompt: ${name}`);
  });
  // Ending the session pauses lease renewal and detaches the recording; the VM
  // is retained for an explicit finish or release, and the backend TTL is the
  // safeguard for an abandoned one.
  const cleanup = async (reason: string) => { try { await manager?.cleanup(reason); } finally { manager = undefined; } };
  return { server, sessionId, project, cleanup, status: () => manager ? manager.status() : { active: false } };
}

async function main(args: string[]): Promise<void> {
  if (args.includes('--instructions')) { process.stdout.write(`${instructions}\n`); return; }
  if (args.includes('--schema')) { process.stdout.write(`${JSON.stringify(allToolDefinitions(), null, 2)}\n`); return; }
  if (args.length) throw new Error('Usage: server.mjs [--instructions | --schema]; with no argument the MCP server speaks on stdin/stdout');
  const relay = createRelayServer();
  let closing: Promise<void> | undefined;
  const shutdown = (reason: string, code: number) => closing ??= (async () => {
    try { await relay.cleanup(reason); }
    catch (error) { process.stderr.write(`mcp-vm-relay: cleanup failed: ${message(error)}\n`); code = 1; }
    finally { process.exit(code); }
  })();
  relay.server.onclose = () => { void shutdown('Enclosure session ended', 0); };
  process.once('SIGTERM', () => { void shutdown('Enclosure session terminated', 0); });
  process.once('SIGINT', () => { void shutdown('Enclosure session interrupted', 0); });
  await relay.server.connect(new StdioServerTransport());
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === await realpath(new URL(import.meta.url)).catch(() => '')) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`mcp-vm-relay: ${message(error)}\n`); process.exitCode = 1; });
}
