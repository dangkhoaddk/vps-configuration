import type { AppsConfig } from './apps-schema.js';
import { loadAppsConfig } from './load-apps-config.js';
import { repoPaths } from '../repo-paths.js';

/** Loads the registry from its one canonical location. Every command starts here. */
export function loadRegistry(): AppsConfig {
  return loadAppsConfig(repoPaths.registry);
}
