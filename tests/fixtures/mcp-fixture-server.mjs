// A stand-in MCP server for the relay_run tests, built with the official SDK.
// It plays cua-driver, Playwright MCP or Chrome DevTools MCP (argv[2] names
// which) and never touches a display. Every tools/call it receives is appended
// to $FIXTURE_LOG, so a test can prove a call was sent once and never replayed.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const name = process.argv[2] ?? 'fixture';
// A 3x2 RGB PNG with valid chunk CRCs, so the host's image presentation decodes it.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGNgYPgPhgwMDP//gykGAEHSBft1tdroAAAAAElFTkSuQmCC';
let count = 0;
const log = entry => { if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, `${JSON.stringify({ server: name, pid: process.pid, ...entry })}\n`); };
const tools = [
  { name: 'increment', description: 'Add to a counter kept in this server process.', inputSchema: { type: 'object', properties: { by: { type: 'integer', minimum: 1 } }, additionalProperties: false } },
  { name: 'echo', description: 'Echo text back.', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false } },
  { name: 'picture', description: 'Return a text block and an image block.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Return a tool error.', inputSchema: { type: 'object', properties: {} } },
  { name: 'escalate', description: 'Refuse before any input, as cua-driver does.', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'Exit the server in the middle of the call.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Answer after a delay.', inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 0 } }, required: ['ms'] } },
  { name: 'huge', description: 'Return more text than the relay passes through.', inputSchema: { type: 'object', properties: {} } },
];
const server = new Server({ name: `fixture-${name}`, version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name: tool, arguments: args = {} } = request.params;
  log({ tool, args });
  switch (tool) {
    case 'increment': count += args.by ?? 1; return { content: [{ type: 'text', text: `count=${count} pid=${process.pid}` }] };
    case 'echo': return { content: [{ type: 'text', text: `echo:${args.text}` }], structuredContent: { echoed: args.text } };
    case 'picture': return { content: [{ type: 'text', text: 'a picture follows' }, { type: 'image', data: PNG, mimeType: 'image/png' }] };
    case 'fail': return { isError: true, content: [{ type: 'text', text: 'fixture tool error' }] };
    case 'escalate': return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'desktop_escalation_required' }) }] };
    case 'crash': setTimeout(() => process.exit(7), 10); return new Promise(() => {});
    case 'slow': await new Promise(done => setTimeout(done, args.ms)); return { content: [{ type: 'text', text: `slept ${args.ms}` }] };
    case 'huge': return { content: [{ type: 'text', text: Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n') }] };
    default: return { isError: true, content: [{ type: 'text', text: `unknown tool ${tool}` }] };
  }
});
await server.connect(new StdioServerTransport());
