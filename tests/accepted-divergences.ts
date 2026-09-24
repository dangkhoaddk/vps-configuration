/**
 * The deliberate divergences between what production currently serves and what
 * this repo renders, as tabulated in docs/parity-exceptions.md.
 *
 * The live capture in baseline/ is committed byte for byte, exactly as
 * `nginx -T` emitted it. Editing it to make the gate pass would destroy the one
 * property that makes it worth having: that it is evidence of what the server
 * actually loaded, not a file someone adjusted until the tests went green.
 *
 * So the accepted divergences are applied on top of it here instead, each as a
 * literal patch that must match. A patch whose `find` text is absent throws
 * rather than silently doing nothing, so a divergence that has since been
 * resolved, or a baseline recaptured after it landed, surfaces as a failure
 * instead of quietly weakening the gate.
 *
 * Every other difference still fails the comparison. Adding an entry here is
 * therefore a deliberate, reviewable act, and it belongs in the same pull
 * request as its row in docs/parity-exceptions.md.
 *
 * Patches operate on NORMALIZED config (see normalize-nginx-config.ts), so the
 * anchors below carry no comments and no blank lines.
 */

export interface AcceptedDivergence {
  /** Why this difference is allowed. Mirrors its row in parity-exceptions.md. */
  readonly reason: string;
  /** Literal normalized text present in the live capture. */
  readonly find: string;
  /** What this repo renders in its place. Empty string means "removed". */
  readonly replace: string;
}

export const ACCEPTED_DIVERGENCES: Readonly<Record<string, readonly AcceptedDivergence[]>> = {
  'conf.d/http.conf': [
    {
      reason:
        "admin added to acme.httpServerNameApps. No behavior change today: this is the sole " +
        "`listen 80` block and so already catches admin's challenges as nginx's default. A " +
        'second port-80 block added ahead of it would have broken admin renewal silently.',
      find: '    server_name api.balispacafe.com www.api.balispacafe.com balispacafe.com www.balispacafe.com;',
      replace:
        '    server_name api.balispacafe.com www.api.balispacafe.com balispacafe.com www.balispacafe.com admin.balispacafe.com www.admin.balispacafe.com;',
    },
  ],

  'conf.d/upstreams.conf': [
    {
      reason:
        'booking_limit removed. A rate-limit zone no limit_req directive referenced, reserving ' +
        '10 MB of shared memory for a limit that never applied.',
      find: '\nlimit_req_zone $binary_remote_addr zone=booking_limit:10m rate=2r/m;',
      replace: '',
    },
    {
      reason:
        "declareIn removed: nestjs_backend moves into api-ssl.conf so that dropping an absent " +
        "app's site file drops its upstream with it. nginx resolves upstreams after parsing all " +
        'of conf.d, so the move is behaviorally inert.',
      find: '\nupstream nestjs_backend {\n    server spa-api:3000;\n}',
      replace: '',
    },
  ],

  'conf.d/api-ssl.conf': [
    {
      reason: 'The other half of the nestjs_backend move out of upstreams.conf.',
      find: 'server {\n    listen 443 ssl;',
      replace: 'upstream nestjs_backend {\n    server spa-api:3000;\n}\nserver {\n    listen 443 ssl;',
    },
  ],
};

/**
 * Applies the accepted divergences for one file to its normalized baseline.
 *
 * @example
 * // input
 * 'conf.d/upstreams.conf', '...\nlimit_req_zone $binary_remote_addr zone=booking_limit:10m rate=2r/m;\n...'
 * // output
 * '...\n...'  // the booking_limit zone removed
 */
export function applyAcceptedDivergences(path: string, normalizedBaseline: string): string {
  const divergences = ACCEPTED_DIVERGENCES[path] ?? [];

  return divergences.reduce((config, { reason, find, replace }) => {
    if (!config.includes(find)) {
      throw new Error(
        `Accepted divergence for ${path} no longer matches the baseline.\n` +
          `  Reason on file: ${reason}\n` +
          `  Expected to find:\n${find}\n` +
          `If the baseline was recaptured after this landed, delete the entry from ` +
          `tests/accepted-divergences.ts and its row in docs/parity-exceptions.md.`,
      );
    }
    return config.replace(find, replace);
  }, normalizedBaseline);
}
