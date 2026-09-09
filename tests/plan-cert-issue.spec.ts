import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadAppsConfig } from '../src/registry/load-apps-config.js';
import { certificateDirectory, planCertIssue } from '../src/commands/plan-cert-issue.js';

/**
 * Certbot argument construction.
 *
 * Worth testing on its own because a mistake here is expensive rather than
 * merely broken: a wrong --cert-name makes nginx fail to load the certificate
 * AND makes every deploy re-request one, burning the Let's Encrypt duplicate
 * quota of five per week.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ENV = {
  NGINX_CONF_DIR: '/home/deploy/spa-api/nginx/conf',
  SNIPPETS_DIR: '/home/deploy/spa-api/nginx/snippets',
  CERTS_ROOT: '/home/deploy/spa-api/certbot',
  ACME_EMAIL: 'ops@example.com',
};

Object.assign(process.env, ENV);
const config = loadAppsConfig(join(REPO_ROOT, 'apps.yml'));
const api = config.apps.find((app) => app.name === 'api')!;

describe('a certificate already exists', () => {
  const decision = planCertIssue(config, 'api', { certificateExists: true });

  it('does nothing, so the duplicate quota is not spent on every deploy', () => {
    expect(decision.kind).toBe('already-issued');
  });
});

describe('no certificate yet', () => {
  const decision = planCertIssue(config, 'api', { certificateExists: false });

  function args(): string[] {
    if (decision.kind !== 'issue') throw new Error('expected issue');
    return decision.certbotArgs;
  }

  it('names the certificate after primaryDomain, not the first -d', () => {
    const index = args().indexOf('--cert-name');
    expect(index).toBeGreaterThan(-1);
    expect(args()[index + 1]).toBe(api.primaryDomain);
  });

  /** The values of every `-d` flag, in order. */
  function requestedDomains(): string[] {
    return args().filter((_, i) => args()[i - 1] === '-d');
  }

  it('requests every domain the app answers on, and no others', () => {
    expect(requestedDomains()).toEqual(api.domains);
  });

  it('runs unattended, as a deploy step must', () => {
    expect(args()).toContain('--non-interactive');
    expect(args()).toContain('--agree-tos');
  });

  it('validates over the webroot the port-80 block serves', () => {
    expect(args()).toContain(`--webroot-path=${config.acme.webroot}`);
  });

  it('passes each value as its own argument, never as a joined string', () => {
    expect(args().every((arg) => !arg.includes(' '))).toBe(true);
  });

  it('excludes compose flags, which the shell prepends', () => {
    expect(args()[0]).toBe('run');
    expect(args()).not.toContain('compose');
  });
});

describe('certificateDirectory', () => {
  it('points where the renderer points ssl_certificate', () => {
    expect(certificateDirectory(config, api)).toBe(
      `${config.paths.certsRoot}/conf/live/${api.primaryDomain}`,
    );
  });
});

describe('an unknown app', () => {
  it('throws, listing the apps that do exist', () => {
    expect(() => planCertIssue(config, 'nope', { certificateExists: false })).toThrow(
      /Unknown app "nope"/,
    );
  });
});
