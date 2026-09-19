import type { AppsConfig } from './apps-schema.js';
import { loadAppsConfig } from './load-apps-config.js';
import { repoPaths } from '../repo-paths.js';

/**
 * Loads the registry from its one canonical location. Every command starts here.
 *
 * @example
 * // input
 * loadRegistry()
 * // output
 * {
 *   network: 'edge_net',
 *   nginxContainer: 'nginx',
 *   paths: { nginxConfDir: '/etc/nginx/conf.d', snippetsDir: '/etc/nginx/snippets', certsRoot: '/etc/letsencrypt' },
 *   acme: { email: 'admin@example.com', webroot: '/var/www/certbot', httpServerNameApps: ['web'] },
 *   monitor: { container: 'netdata', port: 19999 },
 *   apps: [{ name: 'web', domains: ['example.com'], primaryDomain: 'example.com', upstream: { name: 'web_backend', container: 'web', port: 3000 }, frameOptions: 'DENY', websockets: false, includeMonitor: true }],
 * }
 */
export function loadRegistry(): AppsConfig {
  return loadAppsConfig(repoPaths.registry);
}
