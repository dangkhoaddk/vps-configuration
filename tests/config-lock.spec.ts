import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withConfigLock } from '../src/lock/config-lock.js';

let root: string;
let lockDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vpsctl-lock-'));
  lockDir = join(root, '.vpsctl.lock');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Simulates another vpsctl holding the lock. */
function holdLock(acquiredAt: number, command = 'apply --app web'): void {
  writeFileSync(lockDir, JSON.stringify({ acquiredAt, hostname: 'other-host', command }), 'utf8');
}

describe('withConfigLock', () => {
  it('runs the work and returns its value', () => {
    expect(withConfigLock(lockDir, 'apply', () => 42)).toBe(42);
  });

  it('holds the lock for the duration of the work', () => {
    withConfigLock(lockDir, 'apply', () => {
      expect(existsSync(lockDir)).toBe(true);
    });
  });

  it('releases the lock afterwards', () => {
    withConfigLock(lockDir, 'apply', () => undefined);
    expect(existsSync(lockDir)).toBe(false);
  });

  // A crash mid-apply must not wedge every future deploy.
  it('releases the lock when the work throws', () => {
    expect(() =>
      withConfigLock(lockDir, 'apply', () => {
        throw new Error('nginx exploded');
      }),
    ).toThrow('nginx exploded');

    expect(existsSync(lockDir)).toBe(false);
  });

  it('refuses to run concurrently and names the holder', () => {
    holdLock(Date.now(), 'apply --app admin');
    const work = vi.fn();

    expect(() => withConfigLock(lockDir, 'apply --app api', work, { timeoutMs: 0 })).toThrow(
      /apply --app admin/,
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('reports the wait timeout in its error', () => {
    holdLock(Date.now());
    expect(() => withConfigLock(lockDir, 'apply', () => undefined, { timeoutMs: 0 })).toThrow(
      /Timed out/,
    );
  });

  it('leaves someone else\'s lock in place when it gives up', () => {
    holdLock(Date.now());
    expect(() => withConfigLock(lockDir, 'apply', () => undefined, { timeoutMs: 0 })).toThrow();
    expect(existsSync(lockDir)).toBe(true);
  });

  // A killed process leaves the directory behind; without this, one crash would
  // block deploys until someone noticed and removed it by hand.
  it('takes over a stale lock', () => {
    holdLock(Date.now() - 60_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = withConfigLock(lockDir, 'apply', () => 'ran', { staleMs: 1000 });

    expect(result).toBe('ran');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('assuming the holder died'));
  });

  // Atomic acquisition means a lock never exists without metadata, so corrupt
  // contents can only come from disk damage. Age then falls back to mtime, which
  // must never be treated as infinitely old: doing so is what let the previous
  // implementation steal a lock that had just been taken.
  it('does not steal a freshly written but unparseable lock', () => {
    writeFileSync(lockDir, 'not json', 'utf8');
    expect(() => withConfigLock(lockDir, 'apply', () => 'ran', { timeoutMs: 0 })).toThrow(
      /Timed out/,
    );
  });

  it('takes over an old unparseable lock', () => {
    writeFileSync(lockDir, 'not json', 'utf8');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(withConfigLock(lockDir, 'apply', () => 'ran', { timeoutMs: 0, staleMs: -1 })).toBe('ran');
  });

  // The bug this design exists to prevent: a second process must never conclude
  // that a just-acquired lock is stale.
  it('never observes a lock without metadata', () => {
    withConfigLock(lockDir, 'apply --app web', () => {
      const contents = JSON.parse(readFileSync(lockDir, 'utf8')) as { command: string };
      expect(contents.command).toBe('apply --app web');
      expect(Date.now() - (JSON.parse(readFileSync(lockDir, 'utf8')) as { acquiredAt: number }).acquiredAt)
        .toBeLessThan(5000);
    });
  });

  it('leaves no staging files behind', () => {
    withConfigLock(lockDir, 'apply', () => undefined);
    expect(readdirSync(root).filter((f) => f.includes('staging'))).toEqual([]);
  });

  it('does not treat a fresh lock as stale', () => {
    holdLock(Date.now());
    expect(() =>
      withConfigLock(lockDir, 'apply', () => undefined, { timeoutMs: 0, staleMs: 900_000 }),
    ).toThrow(/Timed out/);
  });
});
