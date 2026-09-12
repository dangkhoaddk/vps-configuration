import { composeArgs, runDocker } from '../docker/run-docker.js';

/**
 * Edge stack lifecycle. Thin wrappers so operators have one entry point.
 *
 * @example
 * // input
 * "status"
 * // output
 * 0 // output: side effect — runs `docker compose ps`, prints its stdout/stderr
 */
export function stackCommand(action: 'up' | 'down' | 'status'): number {
  const args =
    action === 'up'
      ? [...composeArgs(), 'up', '-d']
      : action === 'down'
        ? [...composeArgs(), 'down']
        : [...composeArgs(), 'ps'];

  const result = runDocker(args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.ok ? 0 : 1;
}
