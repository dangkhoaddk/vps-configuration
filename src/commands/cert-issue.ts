import { existsSync } from 'node:fs';
import { composeArgs, runDocker } from '../docker/run-docker.js';
import { certificateDirectory, planCertIssue } from './plan-cert-issue.js';
import { withConfigLock } from '../lock/config-lock.js';
import { repoPaths } from '../repo-paths.js';
import { loadRegistry } from '../registry/load-registry.js';
import { selectApps } from '../registry/select-apps.js';

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
  if (options.dryRun === true) return runCertIssue(options);

  // Held for the same reason as apply: certbot writes into the shared certs
  // directory, and issuance races count against the Let's Encrypt quota.
  return withConfigLock(repoPaths.lock, `cert issue ${options.app}`, () => runCertIssue(options));
}

function runCertIssue(options: { app: string; dryRun?: boolean }): number {
  const config = loadRegistry();
  // selectApps throws on an unknown name, so this is always defined.
  const app = selectApps(config, options.app)[0]!;

  const decision = planCertIssue(config, options.app, {
    certificateExists: existsSync(certificateDirectory(config, app)),
  });

  if (decision.kind === 'already-issued') {
    console.log(`✓ certificate for ${decision.primaryDomain} already exists; nothing to do`);
    console.log(`  renewal is handled by the certbot container, not this command`);
    return 0;
  }

  const args = [...composeArgs(), ...decision.certbotArgs];

  if (options.dryRun === true) {
    console.log(`(dry run) docker ${args.join(' ')}`);
    return 0;
  }

  console.log(`Requesting a certificate for ${decision.domains.join(', ')}...`);
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
