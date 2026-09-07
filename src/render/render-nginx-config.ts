import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import type { AppConfig, AppsConfig } from '../config/apps-schema.js';

/**
 * Renders `apps.yml` into the nginx files this project owns.
 *
 * Pure: no filesystem writes, no docker, no network. Everything that touches the
 * outside world lives in the CLI commands, so the parity test stays fast and
 * hermetic and can run in CI with nothing installed.
 */

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../templates');

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
 */
function compileTemplate(fileName: string): HandlebarsTemplateDelegate {
  const source = readFileSync(join(TEMPLATE_DIR, fileName), 'utf8');
  return Handlebars.compile(source, { noEscape: true });
}

function siteFileName(app: AppConfig): string {
  return `${app.name}-ssl.conf`;
}

function renderSite(app: AppConfig): string {
  return compileTemplate('site-ssl.conf.hbs')({
    serverName: app.domains.join(' '),
    certDir: `${CERTS_MOUNT_PATH}/live/${app.primaryDomain}`,
    snippetsMountPath: SNIPPETS_MOUNT_PATH,
    inlineUpstream: app.upstream.declareIn === 'site',
    upstream: app.upstream,
    frameOptions: app.frameOptions,
    websockets: app.websockets,
    clientMaxBodySize: app.clientMaxBodySize,
    includeMonitor: app.includeMonitor,
    rateLimit: app.rateLimit,
  });
}

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
 * Renders the http-level globals and every upstream not declared in a site file.
 *
 * Takes the *selected* apps, not all of them. An upstream naming a container
 * that is not on the shared network stops nginx from starting entirely, whether
 * or not any server block references it, so an app excluded from this render
 * must not leave its upstream behind.
 */
function renderUpstreams(config: AppsConfig, selected: readonly AppConfig[]): string {
  return compileTemplate('upstreams.conf.hbs')({
    upstreams: selected
      .filter((app) => app.upstream.declareIn === 'upstreams')
      .map((app) => app.upstream),
    monitor: config.monitor,
  });
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
 */
export function renderNginxConfig(
  config: AppsConfig,
  apps?: readonly AppConfig[],
): Map<string, string> {
  const selected = apps ?? config.apps;
  const files = new Map<string, string>();

  files.set('conf.d/http.conf', renderHttpAcme(config));
  files.set('conf.d/upstreams.conf', renderUpstreams(config, selected));
  for (const app of selected) {
    files.set(`conf.d/${siteFileName(app)}`, renderSite(app));
  }
  files.set(
    'snippets/monitor.conf',
    readFileSync(join(TEMPLATE_DIR, 'snippets/monitor.conf'), 'utf8'),
  );

  return files;
}
