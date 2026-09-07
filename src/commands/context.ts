import type { AppConfig, AppsConfig } from '../config/apps-schema.js';
import { loadAppsConfig } from '../config/load-apps-config.js';
import { repoPaths } from '../paths.js';

/** Shared setup for every command: load the registry, resolve `--app`. */
export function loadRegistry(): AppsConfig {
  return loadAppsConfig(repoPaths.registry);
}

/**
 * Resolves an optional `--app` filter.
 *
 * An unknown name is an error rather than an empty selection: silently doing
 * nothing because of a typo is how a deploy appears to succeed while changing
 * no routing at all.
 */
export function selectApps(config: AppsConfig, name?: string): AppConfig[] {
  if (name === undefined) return [...config.apps];

  const app = config.apps.find((candidate) => candidate.name === name);
  if (app === undefined) {
    const known = config.apps.map((candidate) => candidate.name).join(', ');
    throw new Error(`Unknown app "${name}". apps.yml defines: ${known}`);
  }
  return [app];
}
