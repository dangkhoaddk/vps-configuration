import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeNginxConfig } from '../compare/normalize-nginx-config.js';
import { findDumpedFile, parseNginxDump } from '../compare/parse-nginx-dump.js';
import { dumpLiveConfig } from '../nginx/dump-live-config.js';
import { renderNginxConfig } from '../render/render-nginx-config.js';
import { loadRegistry } from '../registry/load-registry.js';
import { repoPaths } from '../repo-paths.js';

/**
 * Compares rendered config against the committed baseline, or against what the
 * running nginx actually loaded.
 *
 * Comments and blank lines are normalised away, so this reports behavioural
 * differences rather than wording changes.
 */
export function diffCommand(options: { live?: boolean }): number {
  const config = loadRegistry();
  const files = renderNginxConfig(config);

  const live = options.live === true;
  const dumped = live ? parseNginxDump(dumpLiveConfig(config)) : null;

  let differences = 0;
  for (const [relativePath, rendered] of files) {
    const expected = dumped
      ? findDumpedFile(dumped, relativePath)
      : readBaseline(relativePath);

    if (expected === undefined) {
      console.log(`  ? ${relativePath}: not present in ${live ? 'the live config' : 'the baseline'}`);
      differences += 1;
      continue;
    }

    if (normalizeNginxConfig(rendered) !== normalizeNginxConfig(expected)) {
      console.log(`  ~ ${relativePath}: differs`);
      differences += 1;
    }
  }

  console.log(
    differences === 0
      ? `✓ rendered config matches ${live ? 'the running nginx' : 'the baseline'}`
      : `✗ ${differences} file(s) differ`,
  );
  return differences === 0 ? 0 : 1;
}

function readBaseline(relativePath: string): string | undefined {
  const path = join(repoPaths.baseline, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
