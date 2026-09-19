import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppsConfig } from '../registry/apps-schema.js';
import { runDocker } from '../docker/run-docker.js';
import { hostPathForScratch } from '../host-paths.js';
import { repoPaths } from '../repo-paths.js';
import { findDumpedFile, parseNginxDump } from '../compare/parse-nginx-dump.js';

/**
 * Runs nginx over rendered config in a throwaway container.
 *
 * Two things have to be faked, because nginx resolves both when it *parses* the
 * config rather than when it serves a request:
 *
 *  - Upstream hostnames. Without `--add-host`, nginx fails with
 *    `host not found in upstream "spa-admin:3000"`.
 *  - TLS certificates. nginx loads every `ssl_certificate` file, so the paths
 *    must exist. Self-signed throwaways suffice; only the cert *paths* come from
 *    rendered config, and the parity gate covers those.
 *
 * The nginx image ships openssl, so both happen in one container and nothing
 * beyond docker is needed.
 *
 * `nginx -T` is used rather than `-t`. It tests *and* dumps what was loaded,
 * which lets this assert the rendered files actually reached nginx. That check
 * is not paranoia: docker silently creates a missing bind-mount source as an
 * empty directory, and nginx happily reports success on an empty conf.d. Without
 * it, any path mistake turns this gate into an unconditional pass. That is
 * exactly what happened when the scratch tree lived in the CLI container's own
 * /tmp, which the host daemon cannot see.
 */

/**
 * Must track the image the edge stack runs, so validation cannot pass on config
 * that the real nginx would reject. See stack/compose.edge.yml.
 */
const NGINX_IMAGE = 'nginx:latest';

/** Generates a throwaway cert per domain, then tests and dumps the config. */
const VALIDATE_SCRIPT = `
set -e
for domain in "$@"; do
  mkdir -p "/etc/letsencrypt/live/$domain"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -keyout "/etc/letsencrypt/live/$domain/privkey.pem" \
    -out "/etc/letsencrypt/live/$domain/fullchain.pem" \
    -subj "/CN=$domain" 2>/dev/null
done
nginx -T
`;

export interface ValidationResult {
  ok: boolean;
  /** nginx's own output, verbatim. It names the offending file and line. */
  output: string;
}

/**
 * Writes rendered files into a fresh temp directory tree under repoPaths.scratch,
 * creating conf.d and snippets even when nothing was rendered into them.
 *
 * @example
 * // input
 * writeToScratchTree(new Map([['conf.d/api-ssl.conf', 'server {\n  listen 443 ssl;\n}\n']]))
 * // output
 * '/repo/.scratch/validate-Ab12Cd' // temp dir containing conf.d/api-ssl.conf and an empty snippets/
 */
function writeToScratchTree(files: ReadonlyMap<string, string>): string {
  mkdirSync(repoPaths.scratch, { recursive: true });
  const root = mkdtempSync(join(repoPaths.scratch, 'validate-'));

  for (const [relativePath, content] of files) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  // An include whose directory does not exist is an nginx error, and the monitor
  // snippet is absent whenever the Netdata container is down.
  mkdirSync(join(root, 'conf.d'), { recursive: true });
  mkdirSync(join(root, 'snippets'), { recursive: true });
  return root;
}

/**
 * Runs nginx over the rendered config in a throwaway container and reports
 * whether it loaded cleanly, including whether the rendered files actually
 * reached nginx.
 *
 * @example
 * // input
 * validateRenderedConfig(
 *   { apps: [{ upstream: { container: 'spa-api' }, primaryDomain: 'api.example.com' }], monitor: { container: 'netdata' } } as AppsConfig,
 *   new Map([['conf.d/api-ssl.conf', 'server {\n  listen 443 ssl;\n}\n']]),
 * )
 * // output
 * { ok: true, output: 'configuration file /etc/nginx/nginx.conf test is successful' }
 */
export function validateRenderedConfig(
  config: AppsConfig,
  files: ReadonlyMap<string, string>,
): ValidationResult {
  const root = writeToScratchTree(files);

  try {
    // Bind-mount sources are interpreted by the docker daemon, which runs on the
    // host. When vpsctl is itself containerised the scratch path must be
    // translated back to its host equivalent, or the daemon mounts an empty
    // directory it created instead.
    const hostRoot = hostPathForScratch(root);

    const hostAliases = [
      ...config.apps.map((app) => app.upstream.container),
      config.monitor.container,
    ].flatMap((container) => ['--add-host', `${container}:127.0.0.1`]);

    const result = runDocker([
      'run',
      '--rm',
      '-v',
      `${join(hostRoot, 'conf.d')}:/etc/nginx/conf.d:ro`,
      '-v',
      `${join(hostRoot, 'snippets')}:/etc/nginx/snippets:ro`,
      ...hostAliases,
      NGINX_IMAGE,
      'sh',
      '-c',
      VALIDATE_SCRIPT,
      // Consumed by `"$@"`; the first argument after -c becomes $0.
      'vpsctl-validate',
      ...config.apps.map((app) => app.primaryDomain),
    ]);

    if (!result.ok) {
      return { ok: false, output: joinOutput(result.stdout, result.stderr) };
    }

    const missing = filesNotLoaded(files, result.stdout);
    if (missing.length > 0) {
      return {
        ok: false,
        output:
          `nginx reported success but did not load the rendered config, so nothing ` +
          `was actually validated. This is a bug in vpsctl, not in your config.\n` +
          `  not loaded: ${missing.join(', ')}\n` +
          `  scratch tree: ${root} (host: ${hostRoot})`,
      };
    }

    return { ok: true, output: 'configuration file /etc/nginx/nginx.conf test is successful' };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Rendered files that do not appear in nginx's own dump of what it loaded.
 *
 * @example
 * // input
 * filesNotLoaded(
 *   new Map([['conf.d/api-ssl.conf', 'server {}\n']]),
 *   '# configuration file /etc/nginx/nginx.conf:\n...\n',
 * )
 * // output
 * ['conf.d/api-ssl.conf']
 */
function filesNotLoaded(files: ReadonlyMap<string, string>, dump: string): string[] {
  const loaded = parseNginxDump(dump);
  return [...files.keys()].filter((relativePath) => {
    // Snippets are pulled in by a wildcard include, so a site block that opts out
    // of /monitor/ legitimately leaves the snippet unloaded.
    if (!relativePath.startsWith('conf.d/')) return false;
    return findDumpedFile(loaded, relativePath) === undefined;
  });
}

/**
 * Joins stdout and stderr into one trimmed string, dropping whichever is blank.
 *
 * @example
 * // input
 * joinOutput('configuration file /etc/nginx/nginx.conf test is successful\n', '')
 * // output
 * 'configuration file /etc/nginx/nginx.conf test is successful'
 */
function joinOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((s) => s.trim().length > 0).join('\n').trim();
}
