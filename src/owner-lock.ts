import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { nonblank, pythonExecutable } from "./config.js";

export interface OwnerLockOptions {
  /** Standard-library-only helper; injectable for tests. */
  pythonExecutable?: string;
  /** Bounds helper startup/announcement, not contention retries (there are none). */
  timeoutMs?: number;
  /** Cancellation applies to acquisition only, never to an acquired lock. */
  signal?: AbortSignal;
}
export interface OwnerLock { release(): Promise<void> }
export class OwnerLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OwnerLockError";
  }
}

// fd 3 is a duplicate of the parent's open file description, not a separately
// opened path. flock therefore remains held by the parent even if this helper
// crashes after announcing readiness. NEVER explicitly LOCK_UN in the helper:
// that would unlock the parent's duplicate too. Closing both descriptors is the
// only release. Parent death closes stdin; the helper then closes its duplicate.
const HELPER = `
import fcntl, sys
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.stderr.write("Another relay manager owns this session")
    sys.exit(2)
print("locked", flush=True)
sys.stdin.buffer.read()
`;

/** Acquire a cooperative POSIX session lock on a stable regular-file inode.
 * The caller must supply an existing parent directory and must NEVER unlink or
 * replace this file (including after release). No metadata/PID establishes
 * ownership. Existing directories and symlinks fail closed; legacy directory
 * locks must not be automatically reclaimed.
 *
 * The parent's open descriptor and the helper share the kernel flock. Even a
 * helper crash cannot allow a second owner while this handle remains live.
 * SIGKILL of the parent closes its descriptor and its helper's lifetime pipe.
 */
export async function acquireOwnerLock(path: string, options: OwnerLockOptions = {}): Promise<OwnerLock> {
  const timeoutMs = options.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError("timeoutMs must be a positive bounded integer");
  }
  const executable = options.pythonExecutable === undefined
    ? pythonExecutable()
    : nonblank(options.pythonExecutable, "pythonExecutable");
  const signal = options.signal;
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new OwnerLockError("Owner lock must be a regular file");
    signal?.throwIfAborted();
  } catch (error) {
    await file.close();
    throw error;
  }

  let child;
  try {
    child = spawn(executable, ["-u", "-c", HELPER], {
      stdio: ["pipe", "pipe", "pipe", file.fd],
    });
  } catch (error) {
    await file.close();
    throw new OwnerLockError("Cannot start Python owner lock helper", { cause: error });
  }
  let ended = false;
  let resolveEnd!: () => void;
  const end = new Promise<void>(resolve => { resolveEnd = resolve; });
  const markEnded = () => { ended = true; resolveEnd(); };
  child.once("exit", markEnded);
  child.once("error", markEnded);
  // A helper can exit between release and stdin.end(). EPIPE is not authority.
  child.stdin!.on("error", () => {});
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(0, 4096); });
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => releasePromise ??= (async () => {
    // SIGKILL makes cleanup bounded even for a wedged startup helper. No helper
    // work remains after flock, and the parent's fd preserves exclusivity here.
    if (!ended) child.kill("SIGKILL");
    await end;
    child.stdin!.destroy();
    child.stdout!.destroy();
    child.stderr!.destroy();
    await file.close();
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      let output = "";
      child.stdout!.on("data", chunk => {
        output += String(chunk);
        if (output === "locked\n") resolveReady();
        else if (output.length >= 7) rejectReady(new OwnerLockError("Invalid owner lock helper announcement"));
      });
      child.once("error", error => rejectReady(new OwnerLockError("Cannot start Python owner lock helper", { cause: error })));
      // "close", not "exit": exit can fire before the helper's stderr is read,
      // which would drop the reason (e.g. another manager owns the session).
      child.once("close", () => rejectReady(new OwnerLockError(`Owner lock helper exited before announcement: ${stderr || "no ready response"}`)));
      abort = () => rejectReady(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => rejectReady(new OwnerLockError(`Timed out acquiring owner lock ${path}`)), timeoutMs);
    });
    // Check cancellation after the ready microtask, before handing out authority.
    signal?.throwIfAborted();
    return { release };
  } catch (error) {
    await release();
    throw error;
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
