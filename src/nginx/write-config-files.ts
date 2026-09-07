import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hostPathFor } from '../paths.js';

/**
 * Writes rendered config to the host and removes files this repo no longer owns.
 *
 * The pruning replaces `rm -f ./nginx/conf/default.conf` from the deploy script
 * it supersedes, generalised: anything ending in `.conf` that the renderer did
 * not produce is removed, and every removal is logged. An operator's
 * hand-placed file disappearing silently would be worse than leaving it, so the
 * caller is expected to surface `removed`.
 */

export interface SyncPlan {
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
}

export function isNoOp(plan: SyncPlan): boolean {
  return plan.created.length === 0 && plan.updated.length === 0 && plan.removed.length === 0;
}

function ownedConfFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.conf'));
}

/**
 * Compares rendered output against what is on disk, and optionally applies it.
 *
 * With `dryRun`, nothing is touched; the returned plan is what *would* happen.
 */
/** Only the two directories this module manages; certsRoot is not its concern. */
export interface ManagedDirectories {
  nginxConfDir: string;
  snippetsDir: string;
}

export function syncConfigFiles(
  files: ReadonlyMap<string, string>,
  paths: ManagedDirectories,
  options: { dryRun?: boolean } = {},
): SyncPlan {
  const dryRun = options.dryRun ?? false;
  const plan: SyncPlan = { created: [], updated: [], unchanged: [], removed: [] };

  // Keys are resolved, and looked up with dirname() of a joined path, so the two
  // sides normalise identically. Comparing raw config strings against joined
  // paths breaks on something as ordinary as a trailing slash in .env: the
  // lookup misses, the expected set stays empty, and the prune below deletes
  // every .conf in the directory, including the ones just written.
  const expectedByDirectory = new Map<string, Set<string>>([
    [resolve(paths.nginxConfDir), new Set<string>()],
    [resolve(paths.snippetsDir), new Set<string>()],
  ]);

  for (const [relativePath, content] of files) {
    const target = hostPathFor(relativePath, paths);
    const directory = dirname(target);
    const fileName = basename(target);

    const expected = expectedByDirectory.get(directory);
    if (expected === undefined) {
      // Unreachable unless hostPathFor and this map disagree. Throwing keeps a
      // future mismatch from silently becoming a mass deletion.
      throw new Error(`${relativePath} resolved to ${directory}, which is not a managed directory`);
    }
    expected.add(fileName);

    const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (existing === content) {
      plan.unchanged.push(relativePath);
      continue;
    }

    (existing === null ? plan.created : plan.updated).push(relativePath);
    if (dryRun) continue;

    mkdirSync(directory, { recursive: true });
    writeFileSync(target, content, 'utf8');
    // writeFileSync's `mode` applies only when creating, so set it explicitly.
    // nginx must be able to read these after any hand-edit of permissions.
    chmodSync(target, 0o644);
  }

  for (const [directory, expected] of expectedByDirectory) {
    for (const fileName of ownedConfFiles(directory)) {
      if (expected.has(fileName)) continue;
      plan.removed.push(join(directory, fileName));
      if (!dryRun) rmSync(join(directory, fileName), { force: true });
    }
  }

  return plan;
}
