import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { composeArgs, runDocker } from '../docker/run-docker.js';
import { loadRegistry, selectApps } from './context.js';

/**
 * Obtains a Let's Encrypt certificate for one app, over the ACME webroot the
 * port-80 server block already serves.
 *
 * The existing-certificate check is not an optimisation. Let's Encrypt allows
 * five duplicate certificates per week, and this runs on every deploy: without
 * the guard, a handful of deploys in one day exhausts the quota and blocks
 * genuine renewals. The deploy scripts this replaces had the same guard, and it
 * must survive.
 */
export function certIssueCommand(options: { app: string; dryRun?: boolean }): number {
  const config = loadRegistry();
  // selectApps throws on an unknown name, so this is always defined.
  const app = selectApps(config, options.app)[0]!;

  const liveDir = join(config.paths.certsRoot, 'conf/live', app.primaryDomain);
  if (existsSync(liveDir)) {
    console.log(`✓ certificate for ${app.primaryDomain} already exists; nothing to do`);
    console.log(`  renewal is handled by the certbot container, not this command`);
    return 0;
  }

  const args = [
    ...composeArgs(),
    'run',
    '--rm',
    '--entrypoint',
    '/usr/local/bin/certbot',
    'certbot',
    'certonly',
    // Without --cert-name, certbot names the directory after the FIRST -d
    // domain. The renderer points ssl_certificate at live/<primaryDomain>, and
    // the existing-cert guard above checks that same path, so letting -d
    // ordering decide the name would break both at once: nginx would fail to
    // load the cert, and every deploy would re-request one, burning the Let's
    // Encrypt duplicate-certificate quota (five per week).
    '--cert-name',
    app.primaryDomain,
    '--webroot',
    `--webroot-path=${config.acme.webroot}`,
    '--email',
    config.acme.email,
    '--agree-tos',
    '--no-eff-email',
    '--non-interactive',
    ...app.domains.flatMap((domain) => ['-d', domain]),
  ];

  if (options.dryRun === true) {
    console.log(`(dry run) docker ${args.join(' ')}`);
    return 0;
  }

  console.log(`Requesting a certificate for ${app.domains.join(', ')}...`);
  const result = runDocker(args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (!result.ok) {
    console.error(
      `✗ issuance failed. The port-80 ACME block must serve ${config.acme.webroot} and ` +
        `every domain must resolve to this host.`,
    );
    return 1;
  }

  console.log(`✓ certificate issued for ${app.primaryDomain}`);
  console.log(`  run \`vpsctl apply --app ${app.name}\` so nginx picks it up`);
  return 0;
}
