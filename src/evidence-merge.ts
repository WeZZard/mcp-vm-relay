import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

type Tree = Map<string, "directory" | "file">;

function safePath(value: string): string {
  if (!value || /[\\\x00-\x1f\x7f:#?]/.test(value) || value.split("/").some(p => p === "." || p === "..")) {
    throw new Error(`unsafe evidence path: ${value}`);
  }
  return resolve(value);
}

async function statIfPresent(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function directory(path: string, create = false): Promise<boolean> {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    let info = await statIfPresent(current);
    if (!info && create) {
      await mkdir(current);
      info = await lstat(current);
    }
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe evidence directory: ${current}`);
  }
  return true;
}

async function inventory(root: string): Promise<Tree> {
  const entries: Tree = new Map();
  if (!await directory(root)) return entries;
  const walk = async (prefix: string) => {
    for (const name of await readdir(join(root, prefix))) {
      if (!name || /[\\\x00-\x1f\x7f:#?]/.test(name) || name === "." || name === "..") throw new Error(`unsafe evidence path: ${name}`);
      const path = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error(`symlink in evidence: ${path}`);
      if (info.isDirectory()) {
        entries.set(path, "directory");
        await walk(path);
      } else if (info.isFile() && info.nlink === 1) entries.set(path, "file");
      else throw new Error(`non-regular or hard-linked evidence: ${path}`);
    }
  };
  await walk("");
  return entries;
}

function overlaps(a: string, b: string): boolean {
  const path = relative(a, b);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}

/**
 * Refresh unsealed state from a verified, private staging tree. Callers must
 * serialize access to these trees and retain incoming staging on failure.
 * Snapshot conflicts fail before mutation. Previous state is archived under
 * archiveRoot/<unique-attempt>/state; missing old snapshots are retained too.
 * Copy failures retain both the archive and any partially copied new state.
 */
export async function refreshEvidenceState(incoming: string, destination: string, archiveRoot: string): Promise<void> {
  incoming = safePath(incoming);
  destination = safePath(destination);
  archiveRoot = safePath(archiveRoot);
  const roots = [incoming, destination, archiveRoot];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (overlaps(roots[i]!, roots[j]!) || overlaps(roots[j]!, roots[i]!)) throw new Error("overlapping evidence roots");
  }
  if (!await directory(incoming)) throw new Error("missing incoming evidence state");
  const existing = await directory(destination);
  await directory(archiveRoot);
  if (await statIfPresent(join(dirname(destination), "manifest.json"))) throw new Error("cannot refresh sealed evidence package");
  const fresh = await inventory(incoming), prior = await inventory(destination);
  const retained: Tree = new Map();
  for (const [path, kind] of prior) {
    if (path !== "snapshots" && !path.startsWith("snapshots/")) continue;
    const replacement = fresh.get(path);
    if (replacement && replacement !== kind) throw new Error(`snapshot conflict: ${path}`);
    if (replacement === "file" && !(await readFile(join(destination, path))).equals(await readFile(join(incoming, path)))) {
      throw new Error(`snapshot conflict: ${path}`);
    }
    if (!replacement) retained.set(path, kind);
  }
  // All integrity and path checks precede the first filesystem mutation.
  let archived: string | undefined;
  if (existing) {
    await directory(archiveRoot, true);
    const attempt = await mkdtemp(join(archiveRoot, "attempt-"));
    archived = join(attempt, "state");
    await rename(destination, archived);
  }
  await directory(dirname(destination), true);
  await mkdir(destination);
  const copy = async (source: string, tree: Tree) => {
    for (const [path, kind] of tree) {
      const target = join(destination, path);
      if (kind === "directory") await directory(target, true);
      else {
        await directory(dirname(target), true);
        await copyFile(join(source, path), target, constants.COPYFILE_EXCL);
      }
    }
  };
  await copy(incoming, fresh);
  if (archived) await copy(archived, retained);
}
