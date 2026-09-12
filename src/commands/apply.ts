import { checkUpstreams } from '../nginx/check-upstream-resolvable.js';
import { reloadNginx } from '../nginx/reload-nginx.js';
import { validateRenderedConfig } from '../nginx/validate-config.js';
import { isNoOp, syncConfigFiles } from '../nginx/write-config-files.js';
import { withConfigLock } from '../lock/config-lock.js';
import { repoPaths } from '../repo-paths.js';
import { loadRegistry } from '../registry/load-registry.js';
import { planRender } from './plan-render.js';

export interface ApplyOptions {
  app?: string;
  dryRun?: boolean;
}

/**
 * Render, guard, validate, write, reload.
 *
 * Order matters. The config is validated in a throwaway container *before* the
 * live config is overwritten, so a template bug fails the command instead of
 * taking three sites down. The deploy scripts this replaces wrote first and
 * tested afterwards.
 *
 * @example
 * // input
 * { app: "api", dryRun: false }
 * // output
 * 0 // config rendered, validated, written, and nginx reloaded
 */
export function applyCommand(options: ApplyOptions): number {
  // A dry run never writes, so it does not take the lock. It can therefore read
  // a half-applied state while a real apply is running: the report is advisory,
  // not a snapshot.
  if (options.dryRun === true) return runApply(options);

  return withConfigLock(repoPaths.lock, `apply${options.app ? ` --app ${options.app}` : ''}`, () =>
    runApply(options),
  );
}

/**
 * Does the actual render/validate/write/reload sequence, outside the lock so a
 * dry run can call it directly.
 *
 * @example
 * // input
 * { app: "api", dryRun: true }
 * // output
 * 0 // dry run: logs the planned diff; nothing written, nginx not reloaded
 */
function runApply(options: ApplyOptions): number {
  const config = loadRegistry();
  const dryRun = options.dryRun ?? false;

  // Always check every app, not just the requested one. All apps share one
  // config directory, so rendering a subset would leave the others' files
  // behind to be pruned, silently dropping their routing.
  const availability = checkUpstreams(config, config.apps);

  const decision = planRender(config, availability, options.app);
  for (const warning of decision.warnings) console.warn(warning);
  if (!decision.ok) {
    console.error(decision.error);
    return 1;
  }
  const { files } = decision;

  const validation = validateRenderedConfig(config, files);
  if (!validation.ok) {
    console.error('✗ rendered config failed nginx -t; nothing was written\n');
    console.error(validation.output);
    return 1;
  }
  console.log('✓ rendered config passes nginx -t');

  const plan = syncConfigFiles(files, config.paths, { dryRun: true });
  for (const path of plan.created) console.log(`  + ${path}`);
  for (const path of plan.updated) console.log(`  ~ ${path}`);
  for (const path of plan.removed) console.log(`  - ${path} (no longer rendered)`);

  if (isNoOp(plan)) {
    console.log('✓ no changes; nginx not reloaded');
    return 0;
  }

  if (dryRun) {
    const changes = plan.created.length + plan.updated.length + plan.removed.length;
    console.log(`\n(dry run) ${changes} file(s) would change; nothing was written`);
    return 0;
  }

  syncConfigFiles(files, config.paths);

  const reload = reloadNginx(config);
  if (reload.outcome === 'failed') {
    console.error(`✗ ${reload.detail}`);
    return 1;
  }
  console.log(`✓ ${reload.detail}`);
  return 0;
}
