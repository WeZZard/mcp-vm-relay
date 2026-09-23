import { mkdir, readFile, lstat, mkdtemp, rm, open } from 'node:fs/promises';
import { constants, linkSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash, inventory, within } from './util.js';

/** vm-service is the sole guest communication channel. */
export interface VmChannel {
  exec(name: string, argv: string[], timeoutMs?: number, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>;
  push(name: string, localPath: string, remotePath: string): Promise<unknown>;
  pull(name: string, remotePath: string, localPath: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>;
}
export interface TransferOptions {
  /** Production: the lease's /var/tmp/<timestamp>-mcp-vm-relay-<task> root. */
  guestRoot?: string;
  /** Temporary inventory frames, outside the delivered state/package. */
  hostTempRoot?: string;
  onRetry?: (event: { operation: 'push' | 'pull' | 'metadata'; attempt: number; diagnostic: string }) => Promise<void>;
}
export interface FileFact { path: string; sha256: string; bytes: number }
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_METADATA_BYTES = 4 * 1024 * 1024;
export type ImageTransferErrorCode = 'image-missing' | 'unsafe-path' | 'integrity-failed' | 'transfer-failed';
export class ImageTransferError extends Error {
  constructor(readonly code: ImageTransferErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'ImageTransferError';
  }
}
export interface ImageTransferOptions {
  signal?: AbortSignal;
  /** Absolute Unix milliseconds; capped at 90 seconds from invocation. */
  deadline?: number;
  /** Shared byte-copy attempts across metadata and images in one delivery phase. */
  attemptBudget?: { remaining: number };
  /** Used only by pullImageMetadata; defaults to a single JSON document. */
  metadataFormat?: 'json' | 'jsonl';
}

function imagePath(root: string, target: string) {
  for (const path of [root, target]) {
    if (!isAbsolute(path) || path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) throw new ImageTransferError('unsafe-path', 'Image paths must be absolute and traversal-free');
  }
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new ImageTransferError('unsafe-path', 'Image path escapes approved root');
}
function imageFormat(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    || (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP');
}
function retryableImageCopy(error: unknown): boolean {
  if (error instanceof ImageTransferError) return false;
  const diagnostic = String(error);
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  if (/HTTP 4\d\d|permission denied|unauthori[sz]ed|forbidden|authentication|symlink|not found|no such file|ENOSPC|EACCES|EPERM/i.test(diagnostic)) return false;
  return /connection|timed out|timeout|HTTP 5\d\d|request failed|ECONNRESET|ECONNREFUSED|EPIPE|ENETUNREACH/i.test(diagnostic);
}
function validImageFact(value: unknown, maxBytes = MAX_IMAGE_BYTES): value is { sha256: string; bytes: number } {
  const f = value as FileFact | undefined;
  return !!f && /^[a-f0-9]{64}$/.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes > 0 && f.bytes <= maxBytes;
}

/** Above the approved root OS aliases such as macOS /var -> /private/var are
 * allowed. At and below it every existing component must be non-symlink. */
export async function assertHostPath(root: string, target: string, allowMissing = false): Promise<void> {
  root = resolve(root); target = resolve(target);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`Path must be inside ${root}: ${target}`);
  let path = root;
  for (const part of ['', ...(rel ? rel.split('/') : [])]) {
    if (part) path = join(path, part);
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`symlink ancestor: ${path}`); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }
}
const GUEST_PATH = `function check(root,target,missing=false){root=p.resolve(root);target=p.resolve(target);const rel=p.relative(root,target);if(rel==='..'||rel.startsWith('../')||p.isAbsolute(rel))throw Error('Path must be inside '+root+': '+target);let f=root;for(const part of ['',...(rel?rel.split('/'):[])]){if(part)f=p.join(f,part);try{if(fs.lstatSync(f).isSymbolicLink())throw Error('symlink ancestor '+f);}catch(e){if(missing&&e.code==='ENOENT')return;throw e;}}}`;
const PREPARE = `const fs=require('fs'),p=require('path');${GUEST_PATH}const [root,target]=process.argv.slice(1);check(root,target,true);fs.mkdirSync(p.dirname(target),{recursive:true,mode:448});check(root,target,true);`;
const SCAN = `const fs=require('fs'),p=require('path'),c=require('crypto');${GUEST_PATH}const [root,approved,frame,frameRoot]=process.argv.slice(1),out=[];let total=0;check(approved,root);function walk(f){let s=fs.lstatSync(f);if(s.isSymbolicLink())throw Error('symlink '+f);if(s.isDirectory()){for(const n of fs.readdirSync(f).sort())walk(p.join(f,n));}else if(s.isFile()){total+=s.size;if(total>536870912||out.length>=10000)throw Error('extraction exceeds 512MiB / 10000 files');const b=fs.readFileSync(f);if(b.length!==s.size)throw Error('Source changed during inventory');out.push({path:p.relative(root,f),sha256:c.createHash('sha256').update(b).digest('hex'),bytes:b.length});}else throw Error('special file '+f);}walk(root);check(approved,root);check(frameRoot,frame,true);fs.mkdirSync(p.dirname(frame),{recursive:true,mode:448});check(frameRoot,frame,true);const b=Buffer.from(JSON.stringify(out));fs.writeFileSync(frame,b,{flag:'wx',mode:384});console.log(JSON.stringify({path:frame,sha256:c.createHash('sha256').update(b).digest('hex'),bytes:b.length}));`;
const FILE_FACT = `const fs=require('fs'),p=require('path'),c=require('crypto');${GUEST_PATH}const [root,file]=process.argv.slice(1);check(root,file);const s=fs.lstatSync(file);if(!s.isFile()||s.size>536870912)throw Error('Invalid frame file');const b=fs.readFileSync(file);if(b.length!==s.size)throw Error('Source changed during inventory');check(root,file);console.log(JSON.stringify({path:file,sha256:c.createHash('sha256').update(b).digest('hex'),bytes:b.length}));`;
const REMOVE_FRAME = `const fs=require('fs'),p=require('path');${GUEST_PATH}const [root,file]=process.argv.slice(1);check(root,file,true);fs.rmSync(file,{force:true});`;

// Image metadata is one bounded command per check, never an inventory transfer.
const IMAGE_FACT = `const fs=require('fs'),p=require('path'),c=require('crypto');${GUEST_PATH}
const [root,file,limit='67108864',kind='image']=process.argv.slice(1);
function fail(code,message){throw Object.assign(Error(message),{imageCode:code});}
function identity(s){return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}
try {
  check(root,file); const s=fs.lstatSync(file);
  if(!s.isFile()||s.size<1||s.size>Number(limit))fail('unsafe-path','Expected one regular '+kind+' file of at most '+limit+' bytes');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  let b;
  try {
    if(identity(fs.fstatSync(fd))!==identity(s))fail('integrity-failed','Source changed before image hash');
    b=Buffer.alloc(s.size+1);let n=0,r;
    while(n<b.length&&(r=fs.readSync(fd,b,n,b.length-n,null))>0)n+=r;
    if(n!==s.size||identity(fs.fstatSync(fd))!==identity(s))fail('integrity-failed','Source changed during image hash');
    b=b.subarray(0,n);
  }finally{fs.closeSync(fd);}
  if(kind==='image' && !(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255) || ['GIF87a','GIF89a'].includes(b.subarray(0,6).toString('ascii')) || (b.length>=12&&b.subarray(0,4).toString('ascii')==='RIFF'&&b.subarray(8,12).toString('ascii')==='WEBP')))fail('unsafe-path','Unsupported image format');
  check(root,file);
  if(identity(fs.lstatSync(file))!==identity(s))fail('integrity-failed','Source changed after image hash');
  console.log(JSON.stringify({path:file,sha256:c.createHash('sha256').update(b).digest('hex'),bytes:b.length,identity:identity(s)}));
}catch(e){console.log(JSON.stringify({error:e.imageCode||(e.code==='ENOENT'?'image-missing':/symlink|Path must be inside|ELOOP|ENOTDIR/.test(e.message)?'unsafe-path':'transfer-failed'),message:e.message}));}`;

function validFact(value: unknown): value is FileFact {
  const f = value as FileFact | null;
  return !!f && typeof f === 'object' && typeof f.path === 'string' && typeof f.sha256 === 'string' && /^[a-f0-9]{64}$/.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes >= 0 && f.bytes <= MAX_BYTES;
}

export class Transfer {
  constructor(readonly vm: VmChannel, readonly name: string, readonly node: string, readonly options: TransferOptions = {}) {}
  private async copy(operation: 'push' | 'pull', transfer: () => Promise<unknown>, validate: () => Promise<void>) {
    for (let attempt = 1; ; attempt++) {
      await validate();
      try { await transfer(); return; }
      catch (error) {
        const diagnostic = String(error);
        if (attempt >= 3 || !/scp|ssh|connection|timed out|HTTP 5\d\d|request failed/i.test(diagnostic)) throw error;
        try { await this.options.onRetry?.({ operation, attempt, diagnostic }); }
        catch (retentionError) { throw new AggregateError([error, retentionError], `${diagnostic}; transfer retry evidence failed: ${String(retentionError)}`); }
        await new Promise(resolve => setTimeout(resolve, attempt * 250));
      }
    }
  }
  async checked(argv: string[], timeoutMs?: number) {
    const framed = argv[0] === this.node && argv[1] === '-e'
      ? [argv[0], argv[1], `try { ${argv[2]} } catch(error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode=1; }`, ...argv.slice(3)]
      : argv;
    // These are infrastructure/hash/path commands, never receiver input. Retry
    // only an explicit SSH authentication refusal (before remote dispatch).
    // Network loss and arbitrary nonzero guest outcomes are not replayed.
    for (let attempt = 1; ; attempt++) {
      const result = await this.vm.exec(this.name, framed, timeoutMs);
      if (result.code === 0) return result.stdout;
      const diagnostic = `Guest setup/transfer command failed (${result.code}): ${result.stderr.slice(0, 1000)}`;
      if (attempt >= 3 || result.code !== 255 || !/Permission denied \((?:publickey,)?password(?:,keyboard-interactive)?\)/.test(result.stderr)) throw new Error(diagnostic);
      await this.options.onRetry?.({ operation: 'metadata', attempt, diagnostic });
      await new Promise(resolve => setTimeout(resolve, attempt * 250));
    }
  }
  async pushFile(local: string, remote: string, approvedLocalRoot = dirname(local)) {
    await assertHostPath(approvedLocalRoot, local);
    const info = await lstat(local);
    if (!info.isFile()) throw new Error(`Expected regular file: ${local}`);
    if (info.size > MAX_BYTES) throw new Error('Staging exceeds 512 MiB');
    const bytes = await readFile(local), before = hash(bytes);
    const guestRoot = this.options.guestRoot ?? dirname(remote);
    await this.checked([this.node, '-e', PREPARE, guestRoot, remote]);
    await this.copy('push', () => this.vm.push(this.name, resolve(local), remote), async () => { await assertHostPath(approvedLocalRoot, local); await this.checked([this.node, '-e', PREPARE, guestRoot, remote]); });
    await assertHostPath(approvedLocalRoot, local);
    const after = await readFile(local);
    if (hash(after) !== before || after.length !== bytes.length) throw new Error(`Staging source changed: ${local}`);
    const facts = await this.scan(remote, guestRoot);
    if (facts.length !== 1 || facts[0].sha256 !== before || facts[0].bytes !== bytes.length) throw new Error(`Staging checksum mismatch: ${local}`);
    return { local, remote, sha256: before, bytes: facts[0].bytes };
  }
  async pushTree(local: string, remote: string, approvedLocalRoot = local) {
    await assertHostPath(approvedLocalRoot, local);
    const files = await inventory(local);
    if (files.length > 10000 || files.reduce((sum, file) => sum + file.bytes, 0) > MAX_BYTES) throw new Error('Staging exceeds 512MiB / 10000 files');
    const result = [];
    for (const file of files) {
      const staged = await this.pushFile(within(local, file.path), within(remote, file.path), approvedLocalRoot);
      if (staged.sha256 !== file.sha256 || staged.bytes !== file.bytes) throw new Error(`Staging source changed: ${local}`);
      result.push(staged);
    }
    await assertHostPath(approvedLocalRoot, local);
    if (JSON.stringify(await inventory(local)) !== JSON.stringify(files)) throw new Error(`Staging source changed: ${local}`);
    return result;
  }
  private async guestPath(root: string, target: string) {
    await this.checked([this.node, '-e', `const fs=require('fs'),p=require('path');${GUEST_PATH}check(process.argv[1],process.argv[2]);`, root, target]);
  }
  /** Small stat/hash acknowledgement only; never carry a JSON document on exec stdout. */
  private async fileFact(remote: string, approvedRoot: string): Promise<FileFact> {
    const fact: unknown = JSON.parse(await this.checked([this.node, '-e', FILE_FACT, approvedRoot, remote], 120000));
    if (!validFact(fact) || fact.path !== remote) throw new Error('Invalid remote frame fact');
    return fact;
  }
  /** Pull one bounded frame, compare its bytes, then recheck guest hashes and
   * ancestors. Retains the original host bytes for receipt provenance. */
  async pullFrame(remote: string, local: string, approvedRoot: string, approvedLocalRoot = dirname(local), expected?: FileFact) {
    const before = expected ?? await this.fileFact(remote, approvedRoot);
    if (!validFact(before) || before.path !== remote) throw new Error('Invalid remote frame fact');
    await assertHostPath(approvedLocalRoot, local, true);
    await mkdir(dirname(local), { recursive: true, mode: 0o700 });
    await assertHostPath(approvedLocalRoot, local, true);
    await this.guestPath(approvedRoot, remote);
    await this.copy('pull', () => this.vm.pull(this.name, remote, local), async () => { await this.guestPath(approvedRoot, remote); await assertHostPath(approvedLocalRoot, local, true); });
    await assertHostPath(approvedLocalRoot, local);
    const info = await lstat(local);
    if (!info.isFile()) throw new Error('Invalid local frame file');
    if (info.size !== before.bytes) throw new Error(`Extraction checksum mismatch: ${remote}`);
    const bytes = await readFile(local);
    if (bytes.length !== before.bytes || hash(bytes) !== before.sha256) throw new Error(`Extraction checksum mismatch: ${remote}`);
    if (JSON.stringify(await this.fileFact(remote, approvedRoot)) !== JSON.stringify(before)) throw new Error(`Source changed during extraction: ${remote}`);
    return bytes;
  }
  async imageFact(remote: string, approvedRoot: string, options: ImageTransferOptions = {}): Promise<{ path: string; sha256: string; bytes: number }> {
    const { path, sha256, bytes } = await this.imageMetadata(remote, approvedRoot, options);
    return { path, sha256, bytes };
  }
  private async imageMetadata(remote: string, approvedRoot: string, options: ImageTransferOptions, requireImage = true): Promise<FileFact & { identity: string }> {
    const maxBytes = requireImage ? MAX_IMAGE_BYTES : MAX_IMAGE_METADATA_BYTES;
    imagePath(approvedRoot, remote);
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) throw new ImageTransferError('transfer-failed', 'Invalid image deadline');
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 90_000);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('Image metadata deadline exceeded')), Math.max(0, deadline - Date.now()));
    let listener: (() => void) | undefined;
    try {
      if (controller.signal.aborted || Date.now() >= deadline) throw new ImageTransferError('transfer-failed', 'Image metadata cancelled or deadline exceeded');
      const cancelled = new Promise<never>((_, reject) => {
        listener = () => reject(new ImageTransferError('transfer-failed', 'Image metadata cancelled or deadline exceeded', { cause: controller.signal.reason }));
        controller.signal.addEventListener('abort', listener, { once: true });
      });
      const opts = { signal: controller.signal, timeoutMs: Math.max(1, Math.ceil(deadline - Date.now())) };
      const result = await Promise.race([this.vm.exec(this.name, [this.node, '-e', IMAGE_FACT, approvedRoot, remote, String(maxBytes), requireImage ? 'image' : 'json'], opts.timeoutMs, opts), cancelled]);
      if (controller.signal.aborted || Date.now() >= deadline) throw new ImageTransferError('transfer-failed', 'Image metadata cancelled or deadline exceeded');
      if (result.code !== 0) throw new ImageTransferError('transfer-failed', `Image metadata command failed (${result.code}): ${result.stderr.slice(0, 1000)}`);
      const value = JSON.parse(result.stdout);
      if (value?.error && ['image-missing', 'unsafe-path', 'integrity-failed', 'transfer-failed'].includes(value.error)) throw new ImageTransferError(value.error, String(value.message));
      if (!validImageFact(value, maxBytes) || !('path' in value) || value.path !== remote || !('identity' in value) || typeof value.identity !== 'string') throw new ImageTransferError('integrity-failed', 'Invalid remote image identity');
      return { path: value.path, sha256: value.sha256, bytes: value.bytes, identity: value.identity };
    } catch (cause) {
      if (cause instanceof ImageTransferError) throw cause;
      throw new ImageTransferError('transfer-failed', 'Image metadata failed', { cause });
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (listener) controller.signal.removeEventListener('abort', listener);
    }
  }
  async pullImage(remote: string, local: string, approvedRoot: string, approvedLocalRoot: string,
    expected?: { sha256: string; bytes: number }, options: ImageTransferOptions = {}): Promise<Buffer> {
    return this.pullImageFile(remote, local, approvedRoot, approvedLocalRoot, expected, options, true);
  }
  async pullImageMetadata(remote: string, local: string, approvedRoot: string, approvedLocalRoot: string,
    options: ImageTransferOptions = {}): Promise<Buffer> {
    if (options.metadataFormat !== undefined && options.metadataFormat !== 'json' && options.metadataFormat !== 'jsonl') throw new ImageTransferError('integrity-failed', 'Invalid metadata format');
    return this.pullImageFile(remote, local, approvedRoot, approvedLocalRoot, undefined, options, false);
  }
  private async pullImageFile(remote: string, local: string, approvedRoot: string, approvedLocalRoot: string,
    expected: { sha256: string; bytes: number } | undefined, options: ImageTransferOptions, requireImage: boolean): Promise<Buffer> {
    imagePath(approvedRoot, remote); imagePath(approvedLocalRoot, local);
    const attemptBudget = options.attemptBudget ?? { remaining: 3 };
    if (!Number.isSafeInteger(attemptBudget.remaining) || attemptBudget.remaining < 0) throw new ImageTransferError('transfer-failed', 'Invalid image transfer attempt budget');
    if (expected !== undefined && !validImageFact(expected)) throw new ImageTransferError('integrity-failed', 'Invalid expected image identity');
    if (options.deadline !== undefined && !Number.isFinite(options.deadline)) throw new ImageTransferError('transfer-failed', 'Invalid image deadline');
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 90_000);
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('Image transfer deadline exceeded')), Math.max(0, deadline - Date.now()));
    const guard = () => {
      if (controller.signal.aborted || Date.now() >= deadline) throw new ImageTransferError('transfer-failed', 'Image transfer cancelled or deadline exceeded', { cause: controller.signal.reason });
    };
    // Race even legacy channels that ignore signals. Such a channel may finish a
    // private staging write later, but can never resume verification/publication.
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      guard();
      let listener!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        listener = () => reject(new ImageTransferError('transfer-failed', 'Image transfer cancelled or deadline exceeded', { cause: controller.signal.reason }));
        controller.signal.addEventListener('abort', listener, { once: true });
      });
      try { const value = await Promise.race([operation(), cancelled]); guard(); return value; }
      finally { controller.signal.removeEventListener('abort', listener); }
    };
    const requestOptions = () => ({ signal: controller.signal, timeoutMs: Math.max(1, Math.ceil(deadline - Date.now())) });
    const hostPath = async (path: string, missing = false) => {
      guard();
      try { await assertHostPath(approvedLocalRoot, path, missing); }
      catch (cause) { throw new ImageTransferError('unsafe-path', 'Unsafe local image path', { cause }); }
      guard();
    };
    const fact = () => this.imageMetadata(remote, approvedRoot, { signal: controller.signal, deadline }, requireImage);
    const readImage = async (path: string, identity: { sha256: string; bytes: number }) => {
      await hostPath(path);
      const info = await lstat(path);
      if (!info.isFile()) throw new ImageTransferError('unsafe-path', 'Expected a regular local image');
      if (info.size !== identity.bytes) throw new ImageTransferError('integrity-failed', 'Local image size conflicts with original');
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const same = (s: typeof info) => s.isFile() && s.dev === info.dev && s.ino === info.ino && s.size === info.size && s.mtimeMs === info.mtimeMs && s.ctimeMs === info.ctimeMs;
        if (!same(await fd.stat())) throw new ImageTransferError('integrity-failed', 'Local image changed before verification');
        const bytes = Buffer.alloc(identity.bytes + 1);
        let count = 0;
        while (count < bytes.length) {
          guard();
          const { bytesRead } = await fd.read(bytes, count, bytes.length - count, null);
          if (!bytesRead) break;
          count += bytesRead;
        }
        const result = bytes.subarray(0, count);
        if (count !== identity.bytes || hash(result) !== identity.sha256 || !same(await fd.stat())) throw new ImageTransferError('integrity-failed', 'Local image checksum conflicts with original');
        if (requireImage) {
          if (!imageFormat(result)) throw new ImageTransferError('unsafe-path', 'Unsupported image format');
        } else {
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(result);
            if (options.metadataFormat === 'jsonl') {
              for (const line of text.split('\n')) if (line.trim()) JSON.parse(line);
            } else JSON.parse(text);
          } catch (cause) { throw new ImageTransferError('integrity-failed', 'Invalid image metadata JSON', { cause }); }
        }
        await hostPath(path);
        if (!same(await lstat(path))) throw new ImageTransferError('integrity-failed', 'Local image changed after verification');
        guard(); return result;
      } finally { await fd.close(); }
    };
    const existing = async (identity?: { sha256: string; bytes: number }) => {
      await hostPath(local, true);
      try {
        if (!(await lstat(local)).isFile()) throw new ImageTransferError('unsafe-path', 'Expected a regular local image');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      if (!identity) throw new ImageTransferError('integrity-failed', 'Existing image requires an expected original identity');
      return readImage(local, identity);
    };
    try {
      if (requireImage) {
        const cached = await existing(expected);
        if (cached) { guard(); return cached; }
      }
      const before = await fact();
      if (expected && (before.sha256 !== expected.sha256 || before.bytes !== expected.bytes)) throw new ImageTransferError('integrity-failed', 'Remote image conflicts with original');
      const unchanged = async () => {
        const after = await fact();
        if (after.sha256 !== before.sha256 || after.bytes !== before.bytes || after.identity !== before.identity) throw new ImageTransferError('integrity-failed', 'Source changed during image transfer');
      };
      if (!requireImage) {
        const cached = await existing(before);
        if (cached) { await unchanged(); guard(); return cached; }
      }
      await hostPath(local, true);
      await mkdir(dirname(local), { recursive: true, mode: 0o700 });
      await hostPath(local, true);
      for (let attempt = 1; attempt <= 3; attempt++) {
        guard();
        await unchanged();
        await hostPath(local, true);
        const staging = await mkdtemp(join(dirname(local), '.relay-image-'));
        const staged = join(staging, 'original');
        let pending: Promise<unknown> | undefined;
        const clean = async () => {
          // A replaced ancestor must not turn cleanup into an outside-root write.
          try { await assertHostPath(approvedLocalRoot, staging); await rm(staging, { recursive: true, force: true }); } catch { /* retain unsafe staging for diagnosis */ }
        };
        try {
          await hostPath(staged, true);
          try {
            await bounded(() => {
              guard();
              if (!Number.isSafeInteger(attemptBudget.remaining) || attemptBudget.remaining <= 0) throw new ImageTransferError('transfer-failed', 'Image transfer attempt budget exhausted');
              attemptBudget.remaining--;
              pending = this.vm.pull(this.name, remote, staged, requestOptions());
              return pending;
            });
          } catch (cause) {
            guard();
            const diagnostic = String(cause);
            if (cause instanceof ImageTransferError) throw cause;
            if (attempt >= 3 || attemptBudget.remaining <= 0 || !retryableImageCopy(cause)) throw new ImageTransferError('transfer-failed', `Image byte transfer failed: ${diagnostic}`, { cause });
            await bounded(async () => { await this.options.onRetry?.({ operation: 'pull', attempt, diagnostic }); });
            continue;
          }
          await readImage(staged, before);
          await unchanged();
          const bytes = await readImage(staged, before);
          await hostPath(staged); await hostPath(local, true);
          guard();
          try {
            // Hard-link publication is atomic and fails if any destination exists.
            // Synchronous dispatch leaves no await gap after the cancellation gate.
            linkSync(staged, local);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
            const winner = await existing(before);
            if (!winner) throw new ImageTransferError('integrity-failed', 'Image publication conflict');
            guard(); return winner;
          }
          return bytes;
        } finally {
          if (controller.signal.aborted && pending) void pending.then(clean, clean);
          await clean();
        }
      }
      throw new ImageTransferError('transfer-failed', 'Image transfer attempts exhausted');
    } catch (cause) {
      if (cause instanceof ImageTransferError) throw cause;
      throw new ImageTransferError('transfer-failed', 'Image transfer failed', { cause });
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    }
  }
  async scan(remote: string, approvedRoot = remote): Promise<FileFact[]> {
    // Frames are siblings of state/workspace, never evidence attachments. An
    // inventory of the lease root also works: the frame is created after walk.
    const guestRoot = this.options.guestRoot ?? dirname(remote);
    const frame = join(guestRoot, `.inventory-${randomUUID()}.json`);
    const tempRoot = this.options.hostTempRoot ?? tmpdir();
    await assertHostPath(tempRoot, tempRoot, true);
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    await assertHostPath(tempRoot, tempRoot);
    const hostDirectory = await mkdtemp(join(tempRoot, 'relay-inventory-'));
    try {
      const fact: unknown = JSON.parse(await this.checked([this.node, '-e', SCAN, remote, approvedRoot, frame, guestRoot], 120000));
      if (!validFact(fact) || fact.path !== frame) throw new Error('Invalid remote inventory frame');
      const result: unknown = JSON.parse((await this.pullFrame(frame, join(hostDirectory, 'inventory.json'), guestRoot, tempRoot, fact)).toString('utf8'));
      if (!Array.isArray(result) || result.length > 10000) throw new Error('Invalid remote inventory');
      let total = 0;
      const paths = new Set<string>();
      for (const file of result) {
        if (!validFact(file) || paths.has(file.path)) throw new Error('Invalid remote file fact');
        if (file.path) within('/inventory', file.path);
        else if (result.length !== 1) throw new Error('Invalid remote inventory root file');
        paths.add(file.path); total += file.bytes;
      }
      if (total > MAX_BYTES) throw new Error('Extraction exceeds 512 MiB');
      return result;
    } finally {
      try { await this.checked([this.node, '-e', REMOVE_FRAME, guestRoot, frame]); }
      finally { await assertHostPath(tempRoot, hostDirectory); await rm(hostDirectory, { recursive: true, force: true }); }
    }
  }
  /** Capture source hashes before pull, compare host bytes, then source inventory again. */
  async pullVerified(remote: string, local: string, approvedRoot = remote, localRoot = dirname(local)) {
    const before = await this.scan(remote, approvedRoot);
    await assertHostPath(localRoot, local, true);
    await mkdir(dirname(local), { recursive: true, mode: 0o700 });
    await assertHostPath(localRoot, local, true);
    if (before.length === 1 && before[0].path === '') {
      await this.guestPath(approvedRoot, remote);
      await this.copy('pull', () => this.vm.pull(this.name, remote, local), async () => { await this.guestPath(approvedRoot, remote); await assertHostPath(localRoot, local, true); });
      await this.guestPath(approvedRoot, remote);
      await assertHostPath(localRoot, local);
      if (!(await lstat(local)).isFile()) throw new Error('Invalid extraction file');
      const bytes = await readFile(local);
      if (hash(bytes) !== before[0].sha256 || bytes.length !== before[0].bytes) throw new Error(`Extraction checksum mismatch: ${remote}`);
    } else {
      await mkdir(local, { recursive: true, mode: 0o700 });
      for (const file of before) {
        const path = within(local, file.path);
        await assertHostPath(localRoot, path, true);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await assertHostPath(localRoot, path, true);
        const guestPath = within(remote, file.path);
        await this.guestPath(approvedRoot, guestPath);
        await this.copy('pull', () => this.vm.pull(this.name, guestPath, path), async () => { await this.guestPath(approvedRoot, guestPath); await assertHostPath(localRoot, path, true); });
        await this.guestPath(approvedRoot, guestPath);
        await assertHostPath(localRoot, path);
      }
      await assertHostPath(localRoot, local);
      if (JSON.stringify(await inventory(local)) !== JSON.stringify(before)) throw new Error(`Extraction inventory mismatch: ${remote}`);
    }
    if (JSON.stringify(await this.scan(remote, approvedRoot)) !== JSON.stringify(before)) throw new Error(`Source changed during extraction: ${remote}`);
    await assertHostPath(localRoot, local);
    return before;
  }
}
