import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Handlebars from 'handlebars';
import { repoPaths } from '../repo-paths.js';
import type { AppConfig, AppsConfig } from '../registry/apps-schema.js';

/**
 * Renders `apps.yml` into the nginx files this project owns.
 *
 * Pure: no filesystem writes, no docker, no network. Everything that touches the
 * outside world lives in the CLI commands, so the parity test stays fast and
 * hermetic and can run in CI with nothing installed.
 */

const TEMPLATE_DIR = repoPaths.templates;

/**
 * Paths *inside* the nginx container. nginx includes conf.d/*.conf at http level
 * automatically, which is why location snippets have to live somewhere else.
 */
const SNIPPETS_MOUNT_PATH = '/etc/nginx/snippets';
const CERTS_MOUNT_PATH = '/etc/letsencrypt';

/**
 * Handlebars escapes HTML entities by default, which silently corrupts nginx
 * config: `add_header ... "1; mode=block"` survives, but any `&` in a value
 * becomes `&amp;`. `noEscape` is not optional here.
 *
 * @example
 * // input
 * compileTemplate('http-acme.conf.hbs')
 * // output
 * HandlebarsTemplateDelegate // a compiled template function, ready to call with context data
 */
function compileTemplate(fileName: string): HandlebarsTemplateDelegate {
  const source = readFileSync(join(TEMPLATE_DIR, fileName), 'utf8');
  return Handlebars.compile(source, { noEscape: true });
}

/**
 * @example
 * // input
 * siteFileName({ name: 'web', ... })
 * // output
 * 'web-ssl.conf'
 */
function siteFileName(app: AppConfig): string {
  return `${app.name}-ssl.conf`;
}

/**
 * @example
 * // input
 * renderSite({ name: 'web', domains: ['example.com'], primaryDomain: 'example.com', upstream: { name: 'web_backend', container: 'web', port: 3000 }, frameOptions: 'DENY', websockets: false, includeMonitor: true })
 * // output
 * 'server {\n  server_name example.com;\n  ...\n}\n' // the rendered site-ssl.conf.hbs template
 */
function renderSite(app: AppConfig): string {
  return compileTemplate('site-ssl.conf.hbs')({
    serverName: app.domains.join(' '),
    certDir: `${CERTS_MOUNT_PATH}/live/${app.primaryDomain}`,
    snippetsMountPath: SNIPPETS_MOUNT_PATH,
    upstream: app.upstream,
    frameOptions: app.frameOptions,
    websockets: app.websockets,
    clientMaxBodySize: app.clientMaxBodySize,
    includeMonitor: app.includeMonitor,
    rateLimit: app.rateLimit,
  });
}

/**
 * @example
 * // input
 * renderHttpAcme({ acme: { webroot: '/var/www/certbot', httpServerNameApps: ['web'] }, apps: [{ name: 'web', domains: ['example.com'] }] })
 * // output
 * 'server {\n  listen 80;\n  server_name example.com;\n  ...\n}\n' // the rendered http-acme.conf.hbs template
 */
function renderHttpAcme(config: AppsConfig): string {
  const byName = new Map(config.apps.map((app) => [app.name, app]));
  const serverName = config.acme.httpServerNameApps
    .flatMap((name) => byName.get(name)?.domains ?? [])
    .join(' ');

  return compileTemplate('http-acme.conf.hbs')({
    serverName,
    acmeWebroot: config.acme.webroot,
  });
}

/**
 * Renders the http-level globals and the netdata upstream.
 *
 * App upstreams are not here: each is declared in its own site file, so an app
 * excluded from a render takes its upstream with it. That matters because an
 * upstream naming a container which does not resolve stops nginx from starting
 * entirely, whether or not any server block references it. Keeping the two in
 * one file makes that structural rather than something a filter has to get
 * right.
 *
 * netdata belongs to no app, so it stays here and is gated on `monitor`.
 *
 * @example
 * // input
 * renderUpstreams(config, true)
 * // output
 * 'upstream netdata_backend {\n  server netdata:19999;\n}\n' // the rendered upstreams.conf.hbs template
 */
function renderUpstreams(config: AppsConfig, monitor: boolean): string {
  return compileTemplate('upstreams.conf.hbs')({
    monitor: monitor ? config.monitor : null,
  });
}

export interface RenderOptions {
  /**
   * Apps to emit site blocks for. Defaults to all of them. The CLI narrows this
   * to the apps whose upstream container is currently on the shared network.
   */
  apps?: readonly AppConfig[];
  /**
   * Whether the Netdata container is available. When false, its upstream and
   * the `/monitor/` snippet are both omitted.
   *
   * The netdata upstream is not attached to any one app, so an absent monitor
   * container would otherwise stop nginx starting and take every site down over
   * a monitoring dashboard. Site blocks include the snippet through a wildcard,
   * which matches zero files without error, so dropping both degrades cleanly:
   * `/monitor/` stops resolving and everything else keeps serving.
   */
  monitor?: boolean;
}

/**
 * Renders every owned file, keyed by path relative to the nginx config root.
 *
 * `apps` selects which site blocks to emit. Omit it to render all of them. The
 * CLI passes a subset when an app's upstream container is not resolvable on the
 * shared network, because declaring an upstream for an absent container stops
 * nginx from starting at all.
 *
 * The port-80 ACME block is deliberately NOT filtered by that selection. It
 * proxies to nothing, and certificate renewal has to keep working while an app
 * is down, which is exactly when the app is most likely to be excluded here.
 *
 * @example
 * // input
 * renderNginxConfig(config, { monitor: false })
 * // output
 * Map {
 *   'conf.d/http.conf' => 'server {\n  listen 80;\n  ...\n}\n',
 *   'conf.d/upstreams.conf' => '',
 *   'conf.d/web-ssl.conf' => 'server {\n  server_name example.com;\n  ...\n}\n',
 * } // no 'snippets/monitor.conf' entry since monitor is false
 */
export function renderNginxConfig(
  config: AppsConfig,
  options: RenderOptions = {},
): Map<string, string> {
  const selected = options.apps ?? config.apps;
  const monitor = options.monitor ?? true;
  const files = new Map<string, string>();

  files.set('conf.d/http.conf', renderHttpAcme(config));
  files.set('conf.d/upstreams.conf', renderUpstreams(config, monitor));
  for (const app of selected) {
    files.set(`conf.d/${siteFileName(app)}`, renderSite(app));
  }
  if (monitor) {
    files.set(
      'snippets/monitor.conf',
      readFileSync(join(TEMPLATE_DIR, 'snippets/monitor.conf'), 'utf8'),
    );
  }

  return files;
}
