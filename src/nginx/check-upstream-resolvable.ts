import type { AppConfig, AppsConfig } from '../registry/apps-schema.js';
import { runDockerOrThrow } from '../docker/run-docker.js';

/**
 * Which upstream hostnames nginx will be able to resolve.
 *
 * nginx resolves every upstream hostname when it *loads* its config, including
 * upstreams that no server block references. A name that does not resolve
 * therefore does not degrade one site, it stops nginx from starting at all: the
 * master exits before writing /run/nginx.pid, and every later `nginx -s reload`
 * fails with `invalid PID number ""`.
 *
 * Reproduce it with no VPS:
 *
 *   docker run --rm -v <conf>:/etc/nginx/conf.d:ro nginx:latest nginx -t
 *   nginx: [emerg] host not found in upstream "spa-admin:3000"
 *
 * The three deploy scripts this repo replaces each worked around it separately:
 * starting app containers before nginx, hand-omitting absent upstreams from
 * upstreams.conf, and wildcarding the monitor include. This is that rule stated
 * once.
 *
 * The check resolves names through docker's embedded DNS from inside the
 * network, which is what nginx itself does. Listing container names via
 * `docker network inspect` is not equivalent: it misses network aliases, so a
 * container reachable as `spa-api` but named something else would be wrongly
 * reported absent and its site silently dropped.
 */

/**
 * The nginx image, reused rather than pulling a second one. It is already
 * present on any host running the edge stack, and it resolves names through the
 * same libc as the nginx that will load this config.
 */
const RESOLVER_IMAGE = 'nginx:latest';

const RESOLVE_SCRIPT = `
for host in "$@"; do
  if getent hosts "$host" >/dev/null 2>&1; then echo "$host"; fi
done
`;

/**
 * Resolves every name in one container rather than one container per name.
 *
 * @example
 * // input
 * resolvableHostnames('edge-net', ['spa-api', 'spa-admin', 'netdata'])
 * // output
 * Set { 'spa-api', 'netdata' } // "spa-admin" did not resolve
 */
export function resolvableHostnames(network: string, hostnames: readonly string[]): Set<string> {
  const unique = [...new Set(hostnames)];
  if (unique.length === 0) return new Set();

  const result = runDockerOrThrow(
    [
      'run',
      '--rm',
      '--network',
      network,
      RESOLVER_IMAGE,
      'sh',
      '-c',
      RESOLVE_SCRIPT,
      'vpsctl-resolve',
      ...unique,
    ],
    `Cannot resolve upstream hostnames on network "${network}". Does the network exist?`,
  );

  return new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
}

export interface SkippedApp {
  app: AppConfig;
  reason: string;
}

export interface UpstreamAvailability {
  resolvable: AppConfig[];
  skipped: SkippedApp[];
  /** The Netdata container belongs to no app but is named by upstreams.conf. */
  monitor: boolean;
}

/**
 * Splits the candidate apps into those whose upstream container resolves on
 * the shared network and those that must be skipped, and reports the monitor
 * container separately since it belongs to no app.
 *
 * @example
 * // input
 * checkUpstreams(
 *   { network: 'edge-net', monitor: { container: 'netdata', port: 19999 }, apps: [spaApiConfig, spaAdminConfig] } as AppsConfig,
 *   [spaApiConfig, spaAdminConfig],
 * )
 * // output
 * {
 *   resolvable: [spaApiConfig],
 *   skipped: [{ app: spaAdminConfig, reason: '"spa-admin" does not resolve on network "edge-net"' }],
 *   monitor: true,
 * }
 */
export function checkUpstreams(
  config: AppsConfig,
  candidates: readonly AppConfig[],
): UpstreamAvailability {
  const present = resolvableHostnames(config.network, [
    ...candidates.map((app) => app.upstream.container),
    config.monitor.container,
  ]);

  const resolvable: AppConfig[] = [];
  const skipped: SkippedApp[] = [];

  for (const app of candidates) {
    if (present.has(app.upstream.container)) {
      resolvable.push(app);
    } else {
      skipped.push({
        app,
        reason: `"${app.upstream.container}" does not resolve on network "${config.network}"`,
      });
    }
  }

  return { resolvable, skipped, monitor: present.has(config.monitor.container) };
}
