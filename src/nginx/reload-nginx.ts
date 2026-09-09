import type { AppsConfig } from '../registry/apps-schema.js';
import { composeArgs, runDocker } from '../docker/run-docker.js';

/**
 * Reloads the running nginx.
 *
 * There are three distinct states here, and the deploy scripts this replaces
 * conflated them into `nginx -t && nginx -s reload || force-recreate`:
 *
 *  1. The container is not running. Recreating is the fix.
 *  2. It is running, the config tests clean, but the reload fails. This is the
 *     stale-pid state: nginx previously failed to start (usually an upstream
 *     naming an absent container), exited before writing /run/nginx.pid, and
 *     every reload since fails with `invalid PID number ""`. Retrying never
 *     helps; recreating does.
 *  3. It is running and the config does NOT test clean. Recreating here is
 *     actively harmful: nginx would refuse to start and take every site down.
 *     The old scripts recreated anyway. This reports instead, leaving the
 *     previous good config serving from the running master.
 *
 * `apply` validates in a throwaway container before it writes anything, so
 * state 3 means something outside this repo changed the config.
 */

export type ReloadOutcome = 'reloaded' | 'recreated' | 'failed';

export interface ReloadResult {
  outcome: ReloadOutcome;
  detail: string;
}

function isContainerRunning(name: string): boolean {
  const result = runDocker(['inspect', '-f', '{{.State.Running}}', name]);
  return result.ok && result.stdout.trim() === 'true';
}

function recreate(reason: string): ReloadResult {
  const result = runDocker([...composeArgs(), 'up', '-d', 'nginx', '--force-recreate']);

  return result.ok
    ? { outcome: 'recreated', detail: `${reason}; recreated the nginx container` }
    : { outcome: 'failed', detail: `${reason}; recreate also failed: ${result.stderr.trim()}` };
}

export function reloadNginx(config: AppsConfig): ReloadResult {
  if (!isContainerRunning(config.nginxContainer)) {
    return recreate(`${config.nginxContainer} is not running`);
  }

  const test = runDocker(['exec', config.nginxContainer, 'nginx', '-t']);
  if (!test.ok) {
    return {
      outcome: 'failed',
      detail:
        `nginx -t failed inside ${config.nginxContainer}, so the running config was left ` +
        `alone rather than recreating the container into a non-starting state:\n` +
        test.stderr.trim(),
    };
  }

  const reload = runDocker(['exec', config.nginxContainer, 'nginx', '-s', 'reload']);
  if (reload.ok) {
    return { outcome: 'reloaded', detail: 'nginx reloaded' };
  }

  return recreate(`reload failed (${reload.stderr.trim()})`);
}
