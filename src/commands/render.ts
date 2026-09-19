import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderNginxConfig } from '../render/render-nginx-config.js';
import { loadRegistry } from '../registry/load-registry.js';
import { repoPaths } from '../repo-paths.js';

/**
 * Writes rendered config to a local directory. Touches nothing else.
 *
 * @example
 * // input
 * { out: "./rendered" }
 * // output
 * 0 // output: side effect — writes "./rendered/conf.d/api.conf" etc. to disk, logging each path
 */
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
