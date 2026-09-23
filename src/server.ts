/**
 * mcp-vm-relay: the Model Context Protocol front end of the VM relay.
 *
 * Everything the relay does lives in mcp-vm-relay's host-agnostic core (the
 * manager, the vm-service client, the registry, the strict contract, the
 * action dispatch and the bounded result rendering). This file binds that
 * core to MCP over standard input and output: one `relay` tool with the
 * relay's thirteen actions, plus two operator tools that stand in for pi's
 * `/relay-status` and `/relay-review` commands. The Claude Code plugin in
 * this repository starts this server and carries the relay's working rules
 * as a skill, an agent definition and a session-start hook.
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
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { RelayManager, Registry, doctrine, relayCall, relayJsonSchema, relayToolDescription, relayToolName, selectedEnvironment, verifyDeliveredPackage, type RelayCallResult } from './core.js';

export const SERVER_NAME = 'vm-relay';
/** The build injects this from package.json (esbuild define); under tsx it falls back to reading the file directly. */
declare const __MCP_VM_RELAY_VERSION__: string;
export const SERVER_VERSION = typeof __MCP_VM_RELAY_VERSION__ !== 'undefined' ? __MCP_VM_RELAY_VERSION__
  : (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;
export const STATUS_TOOL = 'relay_status';
export const REVIEW_TOOL = 'relay_review';
/** How the plugin's MCP server names its tools once Claude Code scopes them. */
export const PLUGIN_TOOL_PREFIX = 'mcp__plugin_mcp-vm-relay_vm-relay__';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], isError });
/** A relay result as MCP content: the text, then the delivered image as its own typed block when there is one. */
export function relayContent(result: RelayCallResult) {
  return { content: [{ type: 'text' as const, text: result.text }, ...(result.image ? [{ type: 'image' as const, data: result.image.data, mimeType: result.image.mimeType }] : [])], isError: result.isError };
}

/**
 * The relay contract is a root object with a root-level anyOf holding the
 * strict per-action branches. The Anthropic API drops a root anyOf, so the
 * projected object is offered here and every call is still checked against
 * the strict branches before dispatch (relayCall validates first).
 */
export function relayInputSchema(): Record<string, unknown> {
  const { anyOf: _, ...schema } = relayJsonSchema();
  return schema;
}

/** The project directory: the plugin passes Claude Code's; an unexpanded placeholder or nothing means the server's own working directory. */
export function projectDirectory(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const given = env.MCP_VM_RELAY_PROJECT;
  return given && !given.includes('${') ? resolve(given) : cwd;
}

/** What the session-start hook prints: the relay's working rules, plus the names this runtime gives the tools. */
export function doctrineText(): string {
  return `${doctrine}\nIn Claude Code the relay tool is ${PLUGIN_TOOL_PREFIX}${relayToolName} (or mcp__${SERVER_NAME}__${relayToolName} when the server is configured directly); ${STATUS_TOOL} and ${REVIEW_TOOL} are operator tools for the /relay-status and /relay-review skills.`;
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
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, instructions: doctrineText() });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: relayToolName, description: relayToolDescription, inputSchema: relayInputSchema() },
      { name: STATUS_TOOL, description: 'Show this session\'s owned VM lease (backend binding, guest state, renewal, console observation, last error), staging state and evidence path, plus the project directory, the VM service origin and the selected environment in use; active:false when nothing is owned. Read-only; it does not touch the VM.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: REVIEW_TOOL, description: 'Verify a delivered relay evidence package (all artifacts, hashes and references) and open its viewer in the local human-facing browser. Human review remains pending.', inputSchema: { type: 'object', properties: { directory: { type: 'string', description: 'The package directory, absolute or relative to the project.' } }, required: ['directory'], additionalProperties: false } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === relayToolName) return relayContent(await relayCall(get, args ?? {}, { signal: extra.signal, toolCallId: String(extra.requestId) }));
      if (name === STATUS_TOOL) {
        const environment = selectedEnvironment();
        const service = environment?.profile.vmServiceUrl ?? process.env.MCP_VM_RELAY_URL ?? 'http://localhost:6240';
        return text(JSON.stringify({ ...(manager ? manager.status() : { active: false }), project, service, environment: environment?.identity }, null, 2));
      }
      if (name === REVIEW_TOOL) {
        const directory = (args as { directory?: unknown } | undefined)?.directory;
        if (typeof directory !== 'string' || !directory.trim()) throw new Error('directory is required');
        const root = resolve(project, directory.trim());
        const verified = await verifyDeliveredPackage(root);
        if (!verified.deliveryVerified) throw new Error(`Package failed verification; refusing to open viewer: ${JSON.stringify(verified)}`);
        await (options.open ?? openInBrowser)(pathToFileURL(join(root, 'index.html')).href);
        return text(`Opened verified package: ${root}. Human review remains pending.`);
      }
      throw new Error(`Unknown tool: ${name}`);
    } catch (error) { return text(message(error), true); }
  });
  // Ending the session pauses lease renewal and detaches the recording; the VM
  // is retained for an explicit finish or release, and the backend TTL is the
  // safeguard for an abandoned one.
  const cleanup = async (reason: string) => { try { await manager?.cleanup(reason); } finally { manager = undefined; } };
  return { server, sessionId, project, cleanup, status: () => manager ? manager.status() : { active: false } };
}

async function main(args: string[]): Promise<void> {
  if (args.includes('--doctrine')) { process.stdout.write(`${doctrineText()}\n`); return; }
  if (args.includes('--schema')) { process.stdout.write(`${JSON.stringify(relayInputSchema(), null, 2)}\n`); return; }
  if (args.length) throw new Error('Usage: server.mjs [--doctrine | --schema]; with no argument the MCP server speaks on stdin/stdout');
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
