import type { AppsConfig } from '../registry/apps-schema.js';
import type { UpstreamAvailability } from '../nginx/check-upstream-resolvable.js';
import { renderNginxConfig } from '../render/render-nginx-config.js';
import { selectApps } from '../registry/select-apps.js';

/**
 * Decides what `apply` should render, given which upstreams resolve.
 *
 * Pure: takes upstream availability as data rather than calling docker for it,
 * and returns messages rather than printing them. That is what lets the rules
 * below be tested without a VPS, a docker daemon, or a running app container.
 *
 * The rules are the whole reason this repo exists, so they are worth stating
 * where they can be checked.
 */

/**
 * Both outcomes carry `warnings`. A refusal still has to report which other apps
 * were skipped: the original code printed those before it decided to fail, and
 * dropping them would hide why a deploy stopped.
 */
export type RenderDecision =
  | { ok: false; error: string; warnings: string[] }
  | { ok: true; files: Map<string, string>; warnings: string[] };

/**
 * @example
 * // input
 * config,
 * {
 *   resolvable: [{ name: "api", domains: ["api.balispacafe.com"], primaryDomain: "api.balispacafe.com", ... }],
 *   skipped: [],
 *   monitor: true,
 * },
 * undefined
 * // output
 * {
 *   ok: true,
 *   warnings: [],
 *   files: Map { "conf.d/api.conf" => "server {\n  ...\n}\n" },
 * }
 */
export function planRender(
  config: AppsConfig,
  availability: UpstreamAvailability,
  requestedApp: string | undefined,
): RenderDecision {
  // Throws on an unknown name rather than selecting nothing, so a typo cannot
  // look like a successful run that changed no routing.
  const requested = selectApps(config, requestedApp);
  const { resolvable, skipped, monitor } = availability;

  const warnings = skipped.map(({ app, reason }) => `! skipping ${app.name}: ${reason}`);

  // Being asked to route an app that is not running means the deploy that
  // triggered this did not finish. Warning and exiting 0 would let a broken
  // deploy report success, so this fails instead. Other apps being down is only
  // a warning: they are not what this run was about.
  const requestedButAbsent = skipped.some(({ app }) =>
    requested.some((candidate) => candidate.name === app.name),
  );
  if (requestedApp !== undefined && requestedButAbsent) {
    return {
      ok: false,
      warnings,
      error:
        `✗ ${requestedApp} was requested but its container is not up. ` +
        `Start it before applying, so nginx can resolve its upstream.`,
    };
  }

  if (!monitor) {
    warnings.push(
      `! "${config.monitor.container}" does not resolve on network "${config.network}": ` +
        `rendering without the netdata upstream, so /monitor/ will not resolve`,
    );
  }

  return { ok: true, files: renderNginxConfig(config, { apps: resolvable, monitor }), warnings };
}
