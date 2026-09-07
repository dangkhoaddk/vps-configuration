import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { composeArgs, runDocker } from '../docker/run-docker.js';
import { dumpLiveConfig } from '../nginx/dump-live-config.js';
import { validateRenderedConfig } from '../nginx/validate-config.js';
import { findDumpedFile, parseNginxDump } from '../render/parse-nginx-dump.js';
import { normalizeNginxConfig } from '../render/normalize-nginx-config.js';
import { renderNginxConfig } from '../render/render-nginx-config.js';
import { repoPaths } from '../paths.js';
import { loadRegistry } from './context.js';

/** Writes rendered config to a local directory. Touches nothing else. */
export function renderCommand(options: { out?: string }): number {
  const outDir = options.out ?? repoPaths.renderedOutput;
  const files = renderNginxConfig(loadRegistry());

  for (const [relativePath, content] of files) {
    const target = join(outDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    console.log(`  ${target}`);
  }
  return 0;
}

/** Renders and runs `nginx -t` in a throwaway container. Changes nothing. */
export function validateCommand(): number {
  const config = loadRegistry();
  const result = validateRenderedConfig(config, renderNginxConfig(config));

  console.log(result.output);
  console.log(result.ok ? '✓ config is valid' : '✗ config is invalid');
  return result.ok ? 0 : 1;
}

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

/** Edge stack lifecycle. Thin wrappers so operators have one entry point. */
export function stackCommand(action: 'up' | 'down' | 'status'): number {
  const args =
    action === 'up'
      ? [...composeArgs(), 'up', '-d']
      : action === 'down'
        ? [...composeArgs(), 'down']
        : [...composeArgs(), 'ps'];

  const result = runDocker(args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.ok ? 0 : 1;
}
