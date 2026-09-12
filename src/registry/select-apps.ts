import type { AppConfig, AppsConfig } from './apps-schema.js';

/**
 * Resolves an optional `--app` filter.
 *
 * An unknown name is an error rather than an empty selection: silently doing
 * nothing because of a typo is how a deploy appears to succeed while changing
 * no routing at all.
 *
 * @example
 * // input
 * selectApps(config, 'web')
 * // output
 * [{ name: 'web', domains: ['example.com'], primaryDomain: 'example.com', upstream: { name: 'web_backend', container: 'web', port: 3000 }, frameOptions: 'DENY', websockets: false, includeMonitor: true }]
 *
 * @example
 * // input
 * selectApps(config) // name omitted
 * // output
 * [...config.apps] // every app in the registry
 */
export function selectApps(config: AppsConfig, name?: string): AppConfig[] {
  if (name === undefined) return [...config.apps];

  const app = config.apps.find((candidate) => candidate.name === name);
  if (app === undefined) {
    const known = config.apps.map((candidate) => candidate.name).join(', ');
    throw new Error(`Unknown app "${name}". apps.yml defines: ${known}`);
  }
  return [app];
}
