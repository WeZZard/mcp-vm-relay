import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, lstat, readdir, open } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';

export const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function jsonFile(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(tmp, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export function within(root: string, path: string) {
  if (!path || isAbsolute(path) || path.includes('\0') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid relative path');
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path must be inside ${root}: ${path}`);
  return target;
}
export async function inventory(root: string): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const result: Array<{ path: string; sha256: string; bytes: number }> = [];
  async function walk(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Symlinks are not transferable: ${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    } else if (info.isFile()) {
      const bytes = await readFile(path);
      result.push({ path: relative(root, path), sha256: hash(bytes), bytes: bytes.length });
    } else throw new Error(`Not a regular file: ${path}`);
  }
  await walk(root);
  return result;
}
export async function command(argv: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal });
    let stdout = '', stderr = '', size = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error(`Command timed out: ${argv[0]}`); child.kill('SIGKILL'); }, options.timeoutMs ?? 10000);
    const consume = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 128 * 1024)) { failure = new Error(`Command output exceeded limit: ${argv[0]}`); child.kill('SIGKILL'); return; }
      if (channel === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', chunk => consume('stdout', chunk));
    child.stderr.on('data', chunk => consume('stderr', chunk));
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ stdout, stderr, code: code ?? -1 }); });
  });
}
