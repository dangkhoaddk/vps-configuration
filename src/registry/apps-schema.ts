import { z } from 'zod';

/**
 * Schema for `apps.yml`, the registry describing every site this VPS serves.
 *
 * Two rules govern what belongs here:
 *
 * 1. Every field must exist because a *currently deployed* app needs it. This
 *    registry is not a place to anticipate app #4's requirements.
 * 2. No secrets. `apps.yml` is committed. Values that must stay private are
 *    written as `${ENV_VAR}` and resolved at load time.
 */

/**
 * Values from this registry become shell arguments, nginx identifiers and path
 * segments downstream. Constraining them at parse time is what keeps a registry
 * edit from turning into command injection or path traversal.
 */
const SAFE_HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_APP_NAME = /^[a-z][a-z0-9-]*$/;

/** nginx identifiers (upstream names, limit_req zone names) are C-style. */
const NGINX_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** nginx size values: a number with an optional k/m/g suffix, e.g. `5m`, `1M`. */
const NGINX_SIZE = /^\d+[kKmMgG]?$/;

/** Deliberately loose. Certbot is the real validator; this only blocks nonsense. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(SAFE_HOSTNAME, 'must be a plain hostname (letters, digits, dot, dash, underscore)');

const containerName = z
  .string()
  .min(1)
  .regex(SAFE_CONTAINER_NAME, 'must be a valid docker container or network name');

const nginxIdentifier = z
  .string()
  .min(1)
  .regex(NGINX_IDENTIFIER, 'must be a valid nginx identifier: letters, digits, underscore');

const port = z.number().int().min(1).max(65535);

/**
 * Absolute paths only, with no `..` segment. These are bind-mount sources and
 * write targets; a relative or traversing path here would escape the intended
 * directory.
 */
const absolutePath = z
  .string()
  .min(1)
  .startsWith('/', 'must be an absolute path')
  .refine((p) => !p.split('/').includes('..'), 'must not contain a ".." segment');

const upstreamSchema = z
  .object({
    /** The nginx `upstream` block name, e.g. `nestjs_backend`. */
    name: nginxIdentifier,
    /** Docker container name, resolved over the shared network at nginx config-load time. */
    container: containerName,
    /** Port *inside* the container, not a host-published port. */
    port,
    /**
     * Which rendered file declares this upstream block.
     *
     * This field exists solely to reproduce an existing inconsistency: `api`
     * declares its upstream in `upstreams.conf` while `web` and `admin` declare
     * theirs inline in their own site config. Normalizing that would change
     * rendered output and break the parity gate, so it is recorded as a
     * round-two item in `docs/parity-exceptions.md` rather than fixed here.
     *
     * A new app should use `site`.
     */
    declareIn: z.enum(['upstreams', 'site']),
  })
  .strict();

const rateLimitSchema = z
  .object({
    /** Must match a `limit_req_zone` declared in `upstreams.conf`. */
    zone: nginxIdentifier,
    burst: z.number().int().positive(),
    nodelay: z.boolean(),
  })
  .strict();

const appSchema = z
  .object({
    /** Also the rendered filename stem: `<name>-ssl.conf`. */
    name: z.string().regex(SAFE_APP_NAME, 'must be lowercase letters, digits and dashes'),
    /** Every hostname this app answers on. Rendered into `server_name`. */
    domains: z.array(hostname).min(1),
    /** The hostname the certificate is issued under. Must appear in `domains`. */
    primaryDomain: hostname,
    upstream: upstreamSchema,
    /**
     * `admin` uses SAMEORIGIN while `api` and `web` use DENY. Preserved as-is;
     * see `docs/parity-exceptions.md`.
     */
    frameOptions: z.enum(['DENY', 'SAMEORIGIN']),
    /** Whether to emit the `Upgrade`/`Connection` proxy headers. `admin` does not. */
    websockets: z.boolean(),
    /** Per-server override. Omit to inherit the global value from `upstreams.conf`. */
    clientMaxBodySize: z.string().regex(NGINX_SIZE, 'must be an nginx size, e.g. "5m"').optional(),
    rateLimit: rateLimitSchema.optional(),
    /** Whether this app's server block serves the Netdata dashboard at `/monitor/`. */
    includeMonitor: z.boolean(),
  })
  .strict()
  .refine((app) => app.domains.includes(app.primaryDomain), {
    message: 'primaryDomain must be one of domains',
    path: ['primaryDomain'],
  });

export const appsConfigSchema = z
  .object({
    /** The external docker network every app and the edge stack share. */
    network: containerName,
    /** Container name of the nginx reverse proxy, used for `docker exec` reload. */
    nginxContainer: containerName,
    paths: z
      .object({
        /** Where rendered `*.conf` files are written. nginx includes `*.conf` from here. */
        nginxConfDir: absolutePath,
        /**
         * Location snippets live *outside* `conf.d` on purpose: nginx auto-includes
         * `conf.d/*.conf` at http level, where a bare `location` block is a syntax
         * error. See `docs/architecture.md`.
         */
        snippetsDir: absolutePath,
        /** Certbot state root. Contains `conf/` (i.e. /etc/letsencrypt) and `www/`. */
        certsRoot: absolutePath,
      })
      .strict(),
    acme: z
      .object({
        email: z.string().regex(EMAIL, 'must be an email address'),
        /** Webroot path *inside* the nginx and certbot containers. */
        webroot: absolutePath,
        /**
         * Which apps' domains appear in the port-80 ACME server block.
         *
         * Referenced by app name rather than by repeating hostnames, so domains
         * stay single-sourced in `apps[].domains`.
         *
         * List every app. An app omitted here still renews today, but only
         * because this is the sole `listen 80` server and therefore nginx's
         * default. A second port-80 block added ahead of it would silently break
         * renewal for anything missing from this list, and that failure surfaces
         * weeks later as an expired certificate.
         */
        httpServerNameApps: z.array(z.string()).min(1),
      })
      .strict(),
    monitor: z
      .object({
        container: containerName,
        port,
      })
      .strict(),
    apps: z.array(appSchema).min(1),
  })
  .strict()
  .superRefine((config, ctx) => {
    const seenAppNames = new Set<string>();
    const seenUpstreamNames = new Set<string>();
    // Two server blocks claiming the same server_name is a silent nginx footgun:
    // it warns to stderr and serves whichever block loaded first.
    const domainOwner = new Map<string, string>();

    config.apps.forEach((app, index) => {
      if (seenAppNames.has(app.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate app name "${app.name}"`,
          path: ['apps', index, 'name'],
        });
      }
      seenAppNames.add(app.name);

      if (seenUpstreamNames.has(app.upstream.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate upstream name "${app.upstream.name}"`,
          path: ['apps', index, 'upstream', 'name'],
        });
      }
      seenUpstreamNames.add(app.upstream.name);

      app.domains.forEach((domain, domainIndex) => {
        const owner = domainOwner.get(domain);
        if (owner !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `domain "${domain}" is already served by app "${owner}"`,
            path: ['apps', index, 'domains', domainIndex],
          });
        }
        domainOwner.set(domain, app.name);
      });
    });

    config.acme.httpServerNameApps.forEach((name, index) => {
      if (!seenAppNames.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${name}" is not a defined app`,
          path: ['acme', 'httpServerNameApps', index],
        });
      }
    });
  });

export type AppsConfig = z.infer<typeof appsConfigSchema>;
export type AppConfig = AppsConfig['apps'][number];
export type UpstreamConfig = AppConfig['upstream'];
