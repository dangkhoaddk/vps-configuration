import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAppsConfig } from '../src/registry/load-apps-config.js';
import type { AppConfig, AppsConfig } from '../src/registry/apps-schema.js';
import type { UpstreamAvailability } from '../src/nginx/check-upstream-resolvable.js';
import { planRender } from '../src/commands/plan-render.js';

/**
 * The decisions `apply` makes before it writes anything.
 *
 * These are the rules this repo exists to enforce, and until planRender was
 * extracted none of them were tested: they were fused with docker calls inside
 * the command. Availability is passed as data here, so no daemon is needed.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ENV = {
  NGINX_CONF_DIR: '/home/deploy/spa-api/nginx/conf',
  SNIPPETS_DIR: '/home/deploy/spa-api/nginx/snippets',
  CERTS_ROOT: '/home/deploy/spa-api/certbot',
  ACME_EMAIL: 'ops@example.com',
};

function loadConfig(): AppsConfig {
  Object.assign(process.env, ENV);
  return loadAppsConfig(join(REPO_ROOT, 'apps.yml'));
}

const config = loadConfig();

function appNamed(name: string): AppConfig {
  const app = config.apps.find((candidate) => candidate.name === name);
  if (app === undefined) throw new Error(`apps.yml has no app "${name}"`);
  return app;
}

/** Every container resolves, unless `absent` names one that does not. */
function availability(absent: string[] = [], monitor = true): UpstreamAvailability {
  return {
    resolvable: config.apps.filter((app) => !absent.includes(app.name)),
    skipped: absent.map((name) => ({
      app: appNamed(name),
      reason: `"${appNamed(name).upstream.container}" does not resolve on network "${config.network}"`,
    })),
    monitor,
  };
}

describe('everything is up', () => {
  const decision = planRender(config, availability(), undefined);

  it('renders without warnings', () => {
    expect(decision.ok).toBe(true);
    expect(decision.warnings).toEqual([]);
  });

  it('renders a site file for every app', () => {
    if (!decision.ok) throw new Error('expected ok');
    for (const app of config.apps) {
      expect(decision.files.has(`conf.d/${app.name}-ssl.conf`)).toBe(true);
    }
  });
});

describe('an app whose container is down, with no --app', () => {
  const decision = planRender(config, availability(['web']), undefined);

  it('still renders, and warns about the skipped app', () => {
    expect(decision.ok).toBe(true);
    expect(decision.warnings).toHaveLength(1);
    expect(decision.warnings[0]).toContain('skipping web');
  });

  it('omits the skipped app\'s site file', () => {
    if (!decision.ok) throw new Error('expected ok');
    expect(decision.files.has('conf.d/web-ssl.conf')).toBe(false);
  });

  it('omits the skipped app\'s upstream, which would stop nginx starting', () => {
    if (!decision.ok) throw new Error('expected ok');
    const rendered = [...decision.files.values()].join('\n');
    expect(rendered).not.toContain(appNamed('web').upstream.name);
  });

  it('keeps the skipped app in the port-80 ACME block, so renewal survives', () => {
    if (!decision.ok) throw new Error('expected ok');
    expect(decision.files.get('conf.d/http.conf')).toContain(appNamed('web').primaryDomain);
  });

  it('leaves the other apps rendered', () => {
    if (!decision.ok) throw new Error('expected ok');
    expect(decision.files.has('conf.d/api-ssl.conf')).toBe(true);
    expect(decision.files.has('conf.d/admin-ssl.conf')).toBe(true);
  });
});

describe('the requested app is down', () => {
  const decision = planRender(config, availability(['web']), 'web');

  it('refuses, rather than letting a broken deploy report success', () => {
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('expected refusal');
    expect(decision.error).toContain('web was requested');
  });

  it('still reports which apps were skipped', () => {
    expect(decision.warnings).toHaveLength(1);
    expect(decision.warnings[0]).toContain('skipping web');
  });
});

describe('a different app is down while --app is given', () => {
  const decision = planRender(config, availability(['admin']), 'web');

  it('proceeds, because the other app is not what this run was about', () => {
    expect(decision.ok).toBe(true);
    expect(decision.warnings[0]).toContain('skipping admin');
  });
});

describe('the monitor container is absent', () => {
  const decision = planRender(config, availability([], false), undefined);

  it('warns rather than failing', () => {
    expect(decision.ok).toBe(true);
    expect(decision.warnings.some((w) => w.includes('/monitor/'))).toBe(true);
  });

  it('omits the netdata upstream and the snippet, so the sites keep serving', () => {
    if (!decision.ok) throw new Error('expected ok');
    expect(decision.files.get('conf.d/upstreams.conf')).not.toContain('upstream netdata');
    expect(decision.files.has('snippets/monitor.conf')).toBe(false);
  });

  it('still renders every site', () => {
    if (!decision.ok) throw new Error('expected ok');
    for (const app of config.apps) {
      expect(decision.files.has(`conf.d/${app.name}-ssl.conf`)).toBe(true);
    }
  });
});

describe('an unknown --app', () => {
  it('throws rather than silently changing no routing', () => {
    expect(() => planRender(config, availability(), 'nope')).toThrow(/Unknown app "nope"/);
  });
});
