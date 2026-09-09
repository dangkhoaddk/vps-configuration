import { validateRenderedConfig } from '../nginx/validate-config.js';
import { renderNginxConfig } from '../render/render-nginx-config.js';
import { loadRegistry } from '../registry/load-registry.js';

/** Renders and runs `nginx -t` in a throwaway container. Changes nothing. */
export function validateCommand(): number {
  const config = loadRegistry();
  const result = validateRenderedConfig(config, renderNginxConfig(config));

  console.log(result.output);
  console.log(result.ok ? '✓ config is valid' : '✗ config is invalid');
  return result.ok ? 0 : 1;
}
