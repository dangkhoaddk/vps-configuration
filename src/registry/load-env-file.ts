import { existsSync, readFileSync } from 'node:fs';

/**
 * Loads `stack/.env` into the process environment.
 *
 * The same file configures docker compose and the `${VAR}` references in
 * apps.yml, so reading it here keeps one source of truth. Without this, vpsctl
 * would need its variables exported separately from the ones compose reads, and
 * the two would drift.
 *
 * Values already present in the environment win, so an explicit
 * `NGINX_CONF_DIR=... vpsctl apply` still overrides the file.
 *
 * Deliberately minimal: `KEY=value`, `#` comments, optional surrounding quotes.
 * No interpolation, no multi-line values, no `export` prefix. Compose's own
 * parser accepts more, but every variable this repo uses is a plain path or
 * string, and a permissive hand-rolled parser that disagrees with compose's
 * would be worse than one that only handles the documented shape.
 */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
