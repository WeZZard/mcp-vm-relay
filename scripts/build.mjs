import { build } from 'esbuild';
import { readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await rm('dist', { recursive: true, force: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const common = { bundle: true, platform: 'node', target: 'node22', format: 'esm', metafile: true, define: { __MCP_VM_RELAY_VERSION__: JSON.stringify(pkg.version) } };
// Bundled CommonJS dependencies need a real require; esbuild's ESM output gets one from this banner.
const banner = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";
const receiver = await build({ ...common, entryPoints: ['src/guest/receiver.ts'], outfile: 'dist/receiver.mjs', banner: { js: banner } });
const mcpHost = await build({ ...common, entryPoints: ['src/guest/mcp-host.ts'], outfile: 'dist/mcp-host.mjs', banner: { js: banner } });
const server = await build({ ...common, entryPoints: ['src/server.ts'], outfile: 'dist/server.mjs', banner: { js: `#!/usr/bin/env node\n${banner}` } });
const doctor = await build({ ...common, entryPoints: ['src/doctor.ts'], outfile: 'dist/doctor.mjs', banner: { js: `#!/usr/bin/env node\n${banner}` } });
await chmod('dist/server.mjs', 0o755); await chmod('dist/doctor.mjs', 0o755);
// Compiled relay-driver code is shipped, not fetched by users or copied into VM
// images. Keep exact build provenance; release publication remains explicit.
const packages = [];
for (const name of ['core', 'host-sdk', 'remote-runtime']) {
  const manifest = JSON.parse(await readFile(`node_modules/@wezzard/relay-driver-${name}/package.json`, 'utf8'));
  packages.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? 'UNSPECIFIED', source: 'https://github.com/WeZZard/relay-driver' });
}
const sources = {};
for (const path of [...new Set([receiver, mcpHost, server, doctor].flatMap(r => Object.keys(r.metafile.inputs)))].sort()) {
  const key = path.includes('relay-driver/') ? `relay-driver/${path.split('relay-driver/').at(-1)}` : path;
  sources[key] = createHash('sha256').update(await readFile(path)).digest('hex');
}
await writeFile('dist/build-info.json', JSON.stringify({ formatVersion: 1, packages, sources }, null, 2) + '\n');
await writeFile('dist/NOTICE.txt', 'This distribution includes compiled @wezzard/relay-driver-core, @wezzard/relay-driver-host-sdk and @wezzard/relay-driver-remote-runtime code (https://github.com/WeZZard/relay-driver), the Model Context Protocol TypeScript SDK, and Ajv with ajv-formats (MIT). See build-info.json for source hashes and versions. The relay implementation was inherited from pi-vm-relay (https://github.com/WeZZard/pi-vm-relay) at commit 8990123, synchronized with its implementation through commit 0d69fc7 before that project\'s retirement, and has been maintained here as mcp-vm-relay\'s own implementation from then on.\n');
const integrity = {};
for (const name of ['server.mjs', 'receiver.mjs', 'mcp-host.mjs', 'doctor.mjs']) integrity[name] = createHash('sha256').update(await readFile(`dist/${name}`)).digest('hex');
await writeFile('dist/integrity.json', JSON.stringify(integrity, null, 2) + '\n');
