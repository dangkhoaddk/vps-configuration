import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { repoPaths } from '../repo-paths.js';

/**
 * Every docker invocation goes through here.
 *
 * Arguments are passed as an array, never as a shell string. Values from
 * `apps.yml` reach docker as arguments, and while the schema already constrains
 * them to a safe character set, not involving a shell at all means a schema gap
 * cannot become command execution.
 */

export interface DockerResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export class DockerError extends Error {
  override readonly name = 'DockerError';
}

/**
 * @example
 * // input
 * runDocker(['ps', '--format', '{{.Names}}'])
 * // output
 * { ok: true, code: 0, stdout: 'nginx\nweb\n', stderr: '' }
 */
export function runDocker(args: readonly string[]): DockerResult {
  const result = spawnSync('docker', [...args], {
    encoding: 'utf8',
    // nginx -T on a large config can exceed the 1MB default.
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error !== undefined) {
    throw new DockerError(`Cannot run docker: ${result.error.message}`);
  }

  return {
    ok: result.status === 0,
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Runs docker and throws with the command's own stderr when it fails.
 *
 * @example
 * // input
 * runDockerOrThrow(['exec', 'nginx', 'nginx', '-t'], 'nginx config test failed')
 * // output
 * { ok: true, code: 0, stdout: '', stderr: 'nginx: configuration file /etc/nginx/nginx.conf test is successful\n' }
 */
export function runDockerOrThrow(args: readonly string[], context: string): DockerResult {
  const result = runDocker(args);
  if (!result.ok) {
    throw new DockerError(`${context}\n  docker ${args.join(' ')}\n${result.stderr.trim()}`);
  }
  return result;
}

/**
 * Leading arguments for any compose call against the edge stack.
 *
 * The env file is passed explicitly. Compose would otherwise resolve `.env`
 * relative to the project directory, which changes with the working directory
 * and is exactly the kind of thing that silently picks up the wrong values.
 *
 * @example
 * // input
 * composeArgs()
 * // output
 * ['compose', '--env-file', '/repo/stack/.env', '-f', '/repo/stack/compose.edge.yml']
 */
export function composeArgs(): string[] {
  if (!existsSync(repoPaths.composeEnvFile)) {
    throw new DockerError(
      `${repoPaths.composeEnvFile} is missing.\n` +
        `  Copy stack/.env.example to stack/.env and fill it in.\n` +
        `  Every path in it must be a literal absolute path: docker creates a missing\n` +
        `  bind-mount source as an empty directory instead of failing, so a typo here\n` +
        `  produces an nginx that starts and serves nothing.`,
    );
  }
  return ['compose', '--env-file', repoPaths.composeEnvFile, '-f', repoPaths.composeFile];
}
