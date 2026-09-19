import { linkSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

/**
 * Serialises everything that mutates nginx config or requests certificates.
 *
 * Three app pipelines deploy to one VPS and all of them reach the same nginx
 * config directory. Without a lock, two deploys landing together interleave
 * their writes and reloads, which is the race this repo exists to remove.
 *
 * The lock lives on the filesystem rather than in CI, deliberately. A GitHub
 * `concurrency` group only serialises runs inside one repository's workflows: it
 * does nothing about a second app's pipeline, or an operator running
 * `vpsctl apply` by hand, which is exactly when a deploy is most likely to be in
 * flight.
 *
 * It does NOT protect against an app repo that still writes nginx config with
 * its own deploy script, since those never take the lock. That is a reason to
 * keep the migration window short, not a reason to distrust the lock.
 *
 * ## Why the lock is created with link() rather than mkdir()
 *
 * The obvious implementation, `mkdir` as a mutex and then write the holder
 * metadata inside, has a race that defeats the whole purpose. Between the mkdir
 * and the write there is a window where the lock exists with no metadata. A
 * second process arriving in that window reads no metadata, cannot tell how old
 * the lock is, and either has to treat it as infinitely old (steal it, and now
 * two processes hold the lock) or as brand new (never recover from a crash that
 * happened in that same window).
 *
 * `link()` removes the choice. The metadata is written to a temporary file
 * first, then hard-linked to the lock path in one atomic operation that fails
 * with EEXIST if the path is taken. The lock file therefore never exists without
 * complete, readable metadata, and age is always knowable.
 *
 * Staleness is time-based rather than PID-based: vpsctl usually runs inside a
 * container, where its own PID means nothing to whatever holds the other end.
 * bin/vpsctl bind-mounts the repo, so a containerised run and a host run contend
 * on the same inode.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STALE_MS = 900_000;
const POLL_INTERVAL_MS = 500;

export interface LockOptions {
  /** How long to wait for a held lock before giving up. */
  timeoutMs?: number;
  /** After this long, assume the holder died and take the lock. */
  staleMs?: number;
}

interface LockMetadata {
  acquiredAt: number;
  hostname: string;
  command: string;
}

/**
 * Age of the current holder, in milliseconds.
 *
 * Falls back to the file's mtime when the contents cannot be parsed. Atomic
 * acquisition means that should be unreachable, but guessing "infinitely old"
 * from unreadable metadata is what made the previous implementation steal live
 * locks, so it is worth never doing again.
 *
 * @example
 * // input
 * describeHolder('/repo/.vpsctl.lock')
 * // output
 * { metadata: { acquiredAt: 1717000000000, hostname: 'vps-1', command: 'apply' }, heldForMs: 4200 }
 */
function describeHolder(lockPath: string): { metadata: LockMetadata | null; heldForMs: number } {
  let metadata: LockMetadata | null = null;
  try {
    metadata = JSON.parse(readFileSync(lockPath, 'utf8')) as LockMetadata;
  } catch {
    metadata = null;
  }

  if (metadata !== null && typeof metadata.acquiredAt === 'number') {
    return { metadata, heldForMs: Date.now() - metadata.acquiredAt };
  }

  try {
    return { metadata, heldForMs: Date.now() - statSync(lockPath).mtimeMs };
  } catch {
    // The lock vanished while we were reading it: the holder released it.
    return { metadata, heldForMs: 0 };
  }
}

/**
 * @example
 * // input
 * sleepSync(500)
 * // output
 * undefined // side effect: blocks the current thread for 500ms
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Creates `path` with `content` already in place, or reports that it already
 * exists. Never observable as an empty or partial file: `path` either has its
 * final content the instant it appears, or this process's write never
 * happened at that path at all.
 *
 * Writes to a throwaway sibling file first, then hard-links that file to
 * `path`. `link()` is what makes this atomic: it either succeeds (both names
 * now point at the same, fully-written content) or fails with EEXIST (the
 * path was already taken), with nothing in between.
 *
 * @example
 * // input
 * createFileAtomically('/repo/.vpsctl.lock', '{"command":"apply"}')
 * // output
 * true // created; false if the path already existed
 */
function createFileAtomically(path: string, content: string): boolean {
  const staging = `${path}.staging.${process.pid}.${Math.random().toString(36).slice(2)}`;

  writeFileSync(staging, content, 'utf8');
  try {
    linkSync(staging, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(staging, { force: true });
  }
}

/**
 * Creates the lock, or reports that someone else holds it.
 *
 * @example
 * // input
 * tryAcquire('/repo/.vpsctl.lock', 'apply')
 * // output
 * true // lock acquired; false if another process already holds it
 */
function tryAcquire(lockPath: string, command: string): boolean {
  const metadata: LockMetadata = {
    acquiredAt: Date.now(),
    hostname: process.env['HOSTNAME'] ?? 'unknown',
    command,
  };
  return createFileAtomically(lockPath, JSON.stringify(metadata, null, 2));
}

/**
 * Blocks until the lock at `lockPath` is acquired, taking over a stale one or
 * throwing once `timeoutMs` has passed.
 *
 * Pulled out of `withConfigLock` so that function reads as a straight line:
 * get the lock, then do the work, then release it.
 */
function acquireOrThrow(
  lockPath: string,
  command: string,
  timeoutMs: number,
  staleMs: number,
): void {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryAcquire(lockPath, command)) return;

    const { metadata, heldForMs } = describeHolder(lockPath);

    if (heldForMs > staleMs) {
      // The holder is presumed dead rather than merely slow: nothing else
      // would ever release this lock, so every future apply/cert-issue would
      // otherwise block until a human noticed and deleted it by hand.
      console.warn(
        `! taking a lock held for ${Math.round(heldForMs / 1000)}s by ` +
          `${metadata?.command ?? 'an unknown command'}; assuming the holder died`,
      );
      rmSync(lockPath, { force: true });
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${lockPath}.\n` +
          `  Held by: ${metadata?.command ?? 'unknown'} on ${metadata?.hostname ?? 'unknown host'}` +
          ` for ${Math.round(heldForMs / 1000)}s\n` +
          `  Another deploy is probably in progress. If nothing is running, delete the file.`,
      );
    }

    sleepSync(POLL_INTERVAL_MS);
  }
}

/**
 * Runs `work` while holding the lock, releasing it even if `work` throws or the
 * process is interrupted.
 *
 * Synchronous throughout: every command in this CLI is a linear sequence of
 * blocking docker calls, and an async lock would add concurrency to a tool whose
 * entire purpose is preventing it.
 *
 * @example
 * // input
 * withConfigLock('/repo/.vpsctl.lock', 'apply', () => renderNginxConfig(config))
 * // output
 * Map { 'conf.d/http.conf' => '...', 'conf.d/web-ssl.conf' => '...' } // work()'s return value, after the lock is released
 */
export function withConfigLock<T>(
  lockPath: string,
  command: string,
  work: () => T,
  options: LockOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  acquireOrThrow(lockPath, command, timeoutMs, staleMs);

  const release = (): void => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone: released twice, or taken over as stale.
    }
  };

  // A `finally` never runs when the process is signalled, and an operator
  // interrupting a slow apply is routine. Without this the lock survives until
  // the staleness timeout, blocking every deploy in the meantime.
  const onSignal = (signal: NodeJS.Signals): void => {
    release();
    process.kill(process.pid, signal);
  };
  const handled: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of handled) process.once(signal, onSignal);

  try {
    return work();
  } finally {
    for (const signal of handled) process.removeListener(signal, onSignal);
    release();
  }
}
