import type { AppsConfig } from '../registry/apps-schema.js';
import { runDockerOrThrow } from '../docker/run-docker.js';

/** The config the running nginx actually loaded, as `nginx -T` reports it. */
export function dumpLiveConfig(config: AppsConfig): string {
  return runDockerOrThrow(
    ['exec', config.nginxContainer, 'nginx', '-T'],
    `Cannot read live config from ${config.nginxContainer}. Is it running?`,
  ).stdout;
}
