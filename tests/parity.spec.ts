import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAppsConfig } from '../src/registry/load-apps-config.js';
import { renderNginxConfig } from '../src/render/render-nginx-config.js';
import { normalizeNginxConfig } from '../src/compare/normalize-nginx-config.js';
import { findDumpedFile, parseNginxDump } from '../src/compare/parse-nginx-dump.js';
import { applyAcceptedDivergences } from './accepted-divergences.js';

/**
 * The acceptance criterion for the whole extraction: rendering apps.yml must
 * reproduce the config production already serves.
 *
 * Two sources, in ascending order of authority. See baseline/README.md.
 *
 *  1. baseline/from-deploy-scripts/, reconstructed from the three app repos'
 *     heredocs. A faithful reproduction of what those scripts *write*, which is
 *     not the same as what the VPS *serves*.
 *  2. baseline/nginx-T.baseline.conf, captured from the running nginx. This is
 *     the authority, and it wins automatically as soon as the file exists.
 *
 * Until the capture lands, every difference against the live server is
 * unambiguously production drift. That property is why the registry's rendered
 * output is held byte-stable until it does.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DIR = join(REPO_ROOT, 'baseline/from-deploy-scripts');
const LIVE_CAPTURE = join(REPO_ROOT, 'baseline/nginx-T.baseline.conf');

/**
 * The live dump, parsed, or null when it has not been captured yet.
 *
 * `nginx -T` emits every file nginx loaded, including the image's own
 * nginx.conf and mime.types. Only OWNED_FILES are compared; the rest is parsed
 * and ignored.
 */
const liveDump = existsSync(LIVE_CAPTURE)
  ? parseNginxDump(readFileSync(LIVE_CAPTURE, 'utf8'))
  : null;

/**
 * What the authoritative source says this file should contain, normalized and
 * ready to compare.
 *
 * Against the live capture, the deliberate divergences recorded in
 * docs/parity-exceptions.md are applied on top. The capture itself stays exactly
 * as `nginx -T` emitted it; see tests/accepted-divergences.ts for why the
 * patches live there rather than in the baseline file.
 */
function baselineFor(path: string): string | undefined {
  if (liveDump !== null) {
    const dumped = findDumpedFile(liveDump, path);
    if (dumped === undefined) return undefined;
    return applyAcceptedDivergences(path, normalizeNginxConfig(dumped));
  }

  const fromScripts = join(BASELINE_DIR, path);
  return existsSync(fromScripts) ? normalizeNginxConfig(readFileSync(fromScripts, 'utf8')) : undefined;
}

const ENV = {
  // Where the running nginx actually reads from. Never rendered into config,
  // which uses the container-side /etc/letsencrypt paths, but kept truthful so
  // the fixture cannot teach anyone a path that does not exist on the host.
  NGINX_CONF_DIR: '/root/spa-api/nginx/conf',
  SNIPPETS_DIR: '/root/spa-api/nginx/snippets',
  CERTS_ROOT: '/root/vps-configuration/certbot',
  // Arbitrary: acme.email is used only by `cert issue`, never rendered into config.
  ACME_EMAIL: 'ops@example.com',
};

function render(): Map<string, string> {
  Object.assign(process.env, ENV);
  return renderNginxConfig(loadAppsConfig(join(REPO_ROOT, 'apps.yml')));
}

const OWNED_FILES = [
  'conf.d/http.conf',
  'conf.d/upstreams.conf',
  'conf.d/api-ssl.conf',
  'conf.d/web-ssl.conf',
  'conf.d/admin-ssl.conf',
  'snippets/monitor.conf',
];

describe(`rendered config matches the baseline (${liveDump ? 'live capture' : 'deploy scripts'})`, () => {
  const rendered = render();

  it.each(OWNED_FILES)('%s', (path) => {
    const actual = rendered.get(path);
    expect(actual, `renderer produced no ${path}`).toBeDefined();

    const expected = baselineFor(path);
    expect(expected, `no baseline for ${path}`).toBeDefined();
    expect(normalizeNginxConfig(actual!)).toBe(expected!);
  });

  it('renders exactly the owned files, no more', () => {
    expect([...rendered.keys()].sort()).toEqual([...OWNED_FILES].sort());
  });
});

describe('the parity gate has teeth', () => {
  it('fails when a security header changes', () => {
    Object.assign(process.env, ENV);
    const config = loadAppsConfig(join(REPO_ROOT, 'apps.yml'));
    const tampered = {
      ...config,
      apps: config.apps.map((app) =>
        app.name === 'admin' ? { ...app, frameOptions: 'DENY' as const } : app,
      ),
    };

    const actual = renderNginxConfig(tampered).get('conf.d/admin-ssl.conf')!;
    const expected = baselineFor('conf.d/admin-ssl.conf')!;

    expect(normalizeNginxConfig(actual)).not.toBe(expected);
  });

  it('fails when websocket headers are dropped', () => {
    Object.assign(process.env, ENV);
    const config = loadAppsConfig(join(REPO_ROOT, 'apps.yml'));
    const tampered = {
      ...config,
      apps: config.apps.map((app) => (app.name === 'web' ? { ...app, websockets: false } : app)),
    };

    const actual = renderNginxConfig(tampered).get('conf.d/web-ssl.conf')!;
    const expected = baselineFor('conf.d/web-ssl.conf')!;

    expect(normalizeNginxConfig(actual)).not.toBe(expected);
  });

  it('fails when the rate limit is dropped', () => {
    Object.assign(process.env, ENV);
    const config = loadAppsConfig(join(REPO_ROOT, 'apps.yml'));
    const tampered = {
      ...config,
      apps: config.apps.map((app) =>
        app.name === 'api' ? { ...app, rateLimit: undefined } : app,
      ),
    };

    const actual = renderNginxConfig(tampered).get('conf.d/api-ssl.conf')!;
    const expected = baselineFor('conf.d/api-ssl.conf')!;

    expect(normalizeNginxConfig(actual)).not.toBe(expected);
  });
});

/**
 * When a container is not on the shared network, the CLI renders without that
 * app. Getting this wrong is not a cosmetic bug: an upstream naming an absent
 * container stops nginx from starting at all, which is the exact failure the
 * exclusion exists to prevent.
 */
describe('rendering a subset of apps', () => {
  function renderWithout(name: string): Map<string, string> {
    Object.assign(process.env, ENV);
    const config = loadAppsConfig(join(REPO_ROOT, 'apps.yml'));
    return renderNginxConfig(config, {
      apps: config.apps.filter((app) => app.name !== name),
    });
  }

  it('omits the excluded app\'s site file', () => {
    expect([...renderWithout('admin').keys()]).not.toContain('conf.d/admin-ssl.conf');
  });

  it('omits the excluded app\'s upstream from every rendered file', () => {
    // The upstream is declared in the app's own site file, so dropping the file
    // drops the upstream. nginx refuses to start when an upstream names a
    // container it cannot resolve, so a leftover here would take every site
    // down, not just this one.
    const rendered = [...renderWithout('api').values()].join('\n');
    expect(rendered).not.toContain('nestjs_backend');
    expect(rendered).not.toContain('spa-api:3000');
  });

  it('still declares the netdata upstream, which is not an app', () => {
    expect(renderWithout('api').get('conf.d/upstreams.conf')!).toContain('monitor:19999');
  });

  it('keeps the excluded app in the port-80 ACME block', () => {
    // Certificate renewal must not depend on the app container being up. That is
    // exactly when renewal matters most.
    expect(renderWithout('web').get('conf.d/http.conf')!).toContain('balispacafe.com');
  });

  it('leaves the remaining apps untouched', () => {
    const files = renderWithout('admin');
    const expected = baselineFor('conf.d/web-ssl.conf')!;
    expect(normalizeNginxConfig(files.get('conf.d/web-ssl.conf')!)).toBe(expected);
  });
});

/**
 * The netdata upstream belongs to no app, so an absent monitor container would
 * otherwise stop nginx starting and take all three sites down over a monitoring
 * dashboard. Verified against real nginx: with the upstream gone and the
 * snippets directory empty, the wildcard include matches zero files and the
 * config still passes `nginx -t`.
 */
describe('rendering with the monitor container absent', () => {
  function renderWithoutMonitor(): Map<string, string> {
    Object.assign(process.env, ENV);
    return renderNginxConfig(loadAppsConfig(join(REPO_ROOT, 'apps.yml')), { monitor: false });
  }

  it('omits the netdata upstream', () => {
    const upstreams = renderWithoutMonitor().get('conf.d/upstreams.conf')!;
    expect(upstreams).not.toContain('netdata');
    expect(upstreams).not.toContain('monitor:19999');
    // The dangling `keepalive` must go with it: outside an upstream block it is
    // a hard nginx error, not a warning.
    expect(upstreams).not.toContain('keepalive');
  });

  it('omits the monitor snippet entirely', () => {
    expect([...renderWithoutMonitor().keys()]).not.toContain('snippets/monitor.conf');
  });

  it('leaves every site block untouched, wildcard include included', () => {
    const files = renderWithoutMonitor();
    for (const app of ['api', 'web', 'admin']) {
      const expected = baselineFor(`conf.d/${app}-ssl.conf`)!;
      expect(normalizeNginxConfig(files.get(`conf.d/${app}-ssl.conf`)!)).toBe(expected);
    }
  });

  it('still declares every app upstream, in the site files', () => {
    const files = renderWithoutMonitor();
    expect(files.get('conf.d/api-ssl.conf')!).toContain('nestjs_backend');
    expect(files.get('conf.d/web-ssl.conf')!).toContain('web_frontend_ver2');
    expect(files.get('conf.d/admin-ssl.conf')!).toContain('admin_frontend');
  });
});

describe('renderer never emits Handlebars-escaped entities', () => {
  it.each(OWNED_FILES)('%s', (path) => {
    // A missing `noEscape: true` shows up here rather than as an unreadable diff.
    expect(render().get(path)!).not.toMatch(/&(amp|quot|#x27|lt|gt);/);
  });
});
