import type { AppsConfig } from '../registry/apps-schema.js';
import { runDockerOrThrow } from '../docker/run-docker.js';

/**
 * The config the running nginx actually loaded, as `nginx -T` reports it.
 *
 * @example
 * // input
 * dumpLiveConfig({ nginxContainer: 'edge-nginx', ... } as AppsConfig)
 * // output
 * '# configuration file /etc/nginx/nginx.conf:\n...\n# configuration file /etc/nginx/conf.d/api-ssl.conf:\nserver {\n  listen 443 ssl;\n}\n'
 */
export function dumpLiveConfig(config: AppsConfig): string {
  return runDockerOrThrow(
    ['exec', config.nginxContainer, 'nginx', '-T'],
    `Cannot read live config from ${config.nginxContainer}. Is it running?`,
  ).stdout;
}
