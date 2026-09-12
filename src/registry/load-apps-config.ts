import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { appsConfigSchema, type AppsConfig } from './apps-schema.js';

/** Matches a whole-string `${VAR}` reference. */
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export class AppsConfigError extends Error {
  override readonly name = 'AppsConfigError';
}

/**
 * Replaces `${VAR}` string values with their environment values.
 *
 * Substitution runs on the *parsed* tree rather than the raw file text, so a
 * value containing YAML-significant characters cannot change the document's
 * structure.
 *
 * Only whole-string references are supported. Interpolation inside a larger
 * string (`"prefix-${VAR}"`) is deliberately not implemented: every current use
 * is a whole value, and partial interpolation invites quoting bugs in paths.
 *
 * Missing variables are collected rather than thrown one at a time, so a fresh
 * VPS reports its entire missing `.env` in a single run.
 *
 * @example
 * // input (with ACME_EMAIL=admin@example.com set in the environment)
 * substituteEnvReferences({ email: '${ACME_EMAIL}' }, new Set())
 * // output
 * { email: 'admin@example.com' }
 */
function substituteEnvReferences(node: unknown, missing: Set<string>): unknown {
  if (typeof node === 'string') {
    const match = ENV_REFERENCE.exec(node);
    if (match === null) return node;

    const name = match[1]!;
    const value = process.env[name];
    if (value === undefined || value === '') {
      missing.add(name);
      return node;
    }
    return value;
  }

  if (Array.isArray(node)) {
    return node.map((item) => substituteEnvReferences(item, missing));
  }

  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, substituteEnvReferences(value, missing)]),
    );
  }

  return node;
}

/**
 * @example
 * // input
 * error.issues === [{ path: ['apps', 0, 'name'], message: 'must be lowercase letters, digits and dashes' }]
 * // output
 * '  apps.0.name: must be lowercase letters, digits and dashes'
 */
function formatValidationIssues(error: import('zod').ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  ${path}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Reads, resolves and validates `apps.yml`.
 *
 * Fails loudly and completely: an invalid registry must never render a partial
 * nginx config, because a partial config is one that silently drops a site or a
 * security header.
 *
 * @example
 * // input
 * loadAppsConfig('/repo/apps.yml')
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
export function loadAppsConfig(filePath: string): AppsConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new AppsConfigError(`Cannot read registry at ${filePath}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new AppsConfigError(`${filePath} is not valid YAML`, { cause });
  }

  const missing = new Set<string>();
  const resolved = substituteEnvReferences(parsed, missing);

  if (missing.size > 0) {
    const names = [...missing].sort();
    throw new AppsConfigError(
      `${filePath} references environment variables that are unset or empty:\n` +
        names.map((name) => `  ${name}`).join('\n') +
        `\n\nSet them in the environment, or in stack/.env. See stack/.env.example.`,
    );
  }

  const result = appsConfigSchema.safeParse(resolved);
  if (!result.success) {
    throw new AppsConfigError(
      `${filePath} failed validation:\n${formatValidationIssues(result.error)}`,
    );
  }

  return result.data;
}
