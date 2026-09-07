import { checkUpstreams } from '../nginx/check-upstream-resolvable.js';
import { reloadNginx } from '../nginx/reload-nginx.js';
import { validateRenderedConfig } from '../nginx/validate-config.js';
import { isNoOp, syncConfigFiles } from '../nginx/write-config-files.js';
import { renderNginxConfig } from '../render/render-nginx-config.js';
import { withConfigLock } from '../lock/config-lock.js';
import { repoPaths } from '../paths.js';
import { loadRegistry, selectApps } from './context.js';

/**
 * Render, guard, validate, write, reload.
 *
 * Order matters. The config is validated in a throwaway container *before* the
 * live config is overwritten, so a template bug fails the command instead of
 * taking three sites down. The deploy scripts this replaces wrote first and
 * tested afterwards.
 */
export function applyCommand(options: { app?: string; dryRun?: boolean }): number {
  // A dry run never writes, so it does not take the lock. It can therefore read
  // a half-applied state while a real apply is running: the report is advisory,
  // not a snapshot.
  if (options.dryRun === true) return runApply(options);

  return withConfigLock(repoPaths.lock, `apply${options.app ? ` --app ${options.app}` : ''}`, () =>
    runApply(options),
  );
}

function runApply(options: { app?: string; dryRun?: boolean }): number {
  const config = loadRegistry();
  const requested = selectApps(config, options.app);
  const dryRun = options.dryRun ?? false;

  // Always check every app, not just the requested one. All apps share one
  // config directory, so rendering a subset would leave the others' files
  // behind to be pruned, silently dropping their routing.
  const { resolvable, skipped, monitor } = checkUpstreams(config, config.apps);

  for (const { app, reason } of skipped) {
    console.warn(`! skipping ${app.name}: ${reason}`);
  }

  // Being asked to route an app that is not running means the deploy that
  // triggered this did not finish. Warning and exiting 0 would let a broken
  // deploy report success, so this fails instead. Other apps being down is only
  // a warning: they are not what this run was about.
  const requestedButAbsent = skipped.filter(({ app }) =>
    requested.some((candidate) => candidate.name === app.name),
  );
  if (options.app !== undefined && requestedButAbsent.length > 0) {
    console.error(
      `✗ ${options.app} was requested but its container is not up. ` +
        `Start it before applying, so nginx can resolve its upstream.`,
    );
    return 1;
  }

  if (!monitor) {
    console.warn(
      `! "${config.monitor.container}" does not resolve on network "${config.network}": ` +
        `rendering without the netdata upstream, so /monitor/ will not resolve`,
    );
  }

  const files = renderNginxConfig(config, { apps: resolvable, monitor });

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
