import { join } from 'node:path';
import type { AppConfig, AppsConfig } from '../registry/apps-schema.js';
import { selectApps } from '../registry/select-apps.js';

/**
 * Decides whether to request a certificate, and builds the certbot arguments.
 *
 * Pure: takes "does a certificate already exist" as data rather than touching
 * the filesystem, and returns arguments rather than running docker. The argv it
 * builds is worth testing on its own, because a mistake there is expensive
 * rather than merely broken. See the --cert-name note below.
 *
 * Returns only the certbot portion. `composeArgs()` reads the environment file
 * and throws when it is missing, so it stays in the command shell.
 */

export type CertIssueDecision =
  | { kind: 'already-issued'; primaryDomain: string }
  | { kind: 'issue'; certbotArgs: string[]; domains: string[]; primaryDomain: string };

/**
 * Where certbot keeps this app's certificate, and where the renderer points nginx.
 *
 * @example
 * // input
 * config.paths.certsRoot === "/opt/certbot"
 * app === { name: "api", domains: ["api.balispacafe.com"], primaryDomain: "api.balispacafe.com", ... }
 * // output
 * "/opt/certbot/conf/live/api.balispacafe.com"
 */
export function certificateDirectory(config: AppsConfig, app: AppConfig): string {
  return join(config.paths.certsRoot, 'conf/live', app.primaryDomain);
}

/**
 * Decides whether `cert-issue` needs to call certbot at all, and if so builds
 * the exact `certbot certonly` argv for it.
 *
 * @example
 * // input
 * config, "api", { certificateExists: false }
 * // output
 * {
 *   kind: "issue",
 *   domains: ["api.balispacafe.com"],
 *   primaryDomain: "api.balispacafe.com",
 *   certbotArgs: [
 *     "run", "--rm", "--entrypoint", "/usr/local/bin/certbot", "certbot", "certonly",
 *     "--cert-name", "api.balispacafe.com",
 *     "--webroot", "--webroot-path=/var/www/certbot",
 *     "--email", "ops@balispacafe.com", "--agree-tos", "--no-eff-email", "--non-interactive",
 *     "-d", "api.balispacafe.com",
 *   ],
 * }
 */
export function planCertIssue(
  config: AppsConfig,
  appName: string,
  state: { certificateExists: boolean },
): CertIssueDecision {
  // selectApps throws on an unknown name, so this is always defined.
  const app = selectApps(config, appName)[0]!;

  if (state.certificateExists) {
    return { kind: 'already-issued', primaryDomain: app.primaryDomain };
  }

  return {
    kind: 'issue',
    domains: [...app.domains],
    primaryDomain: app.primaryDomain,
    certbotArgs: [
      'run',
      '--rm',
      '--entrypoint',
      '/usr/local/bin/certbot',
      'certbot',
      'certonly',
      // Without --cert-name, certbot names the directory after the FIRST -d
      // domain. The renderer points ssl_certificate at live/<primaryDomain>, and
      // the existing-cert guard checks that same path, so letting -d ordering
      // decide the name would break both at once: nginx would fail to load the
      // cert, and every deploy would re-request one, burning the Let's Encrypt
      // duplicate-certificate quota (five per week).
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
    ],
  };
}
