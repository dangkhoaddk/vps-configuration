/**
 * Parses the output of `nginx -T` into a map of config path to file content.
 *
 * `nginx -T` prints every file nginx actually loaded, each preceded by a
 * `# configuration file <path>:` header. That includes files this project does
 * not own, notably the base `nginx.conf` and `mime.types` from the image. The
 * parity gate compares only the paths listed in the renderer's output, so the
 * rest is parsed and ignored rather than being allowed to fail a comparison.
 */

const FILE_HEADER = /^# configuration file (.+):$/;

/**
 * Splits an `nginx -T` dump into a map of absolute config path to file content.
 *
 * @example
 * // input
 * '# configuration file /etc/nginx/conf.d/api-ssl.conf:\nserver {\n  listen 443 ssl;\n}\n'
 * // output
 * Map { '/etc/nginx/conf.d/api-ssl.conf' => 'server {\n  listen 443 ssl;\n}\n' }
 */
export function parseNginxDump(dump: string): Map<string, string> {
  const files = new Map<string, string>();

  let currentPath: string | null = null;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentPath === null) return;
    // A file included more than once is dumped more than once. Keep the first
    // copy: later copies are identical, and overwriting would hide it if they
    // ever were not.
    if (!files.has(currentPath)) {
      files.set(currentPath, currentLines.join('\n'));
    }
  };

  for (const line of dump.split('\n')) {
    const header = FILE_HEADER.exec(line);
    if (header !== null) {
      flush();
      currentPath = header[1]!;
      currentLines = [];
      continue;
    }
    if (currentPath !== null) currentLines.push(line);
  }
  flush();

  return files;
}

/**
 * Finds a dumped file by the trailing part of its path.
 *
 * The renderer works in relative paths (`conf.d/api-ssl.conf`) while a dump
 * carries absolute container paths (`/etc/nginx/conf.d/api-ssl.conf`). Matching
 * on the suffix keeps the renderer independent of where nginx mounts things.
 *
 * @example
 * // input
 * findDumpedFile(
 *   new Map([['/etc/nginx/conf.d/api-ssl.conf', 'server {\n  listen 443 ssl;\n}\n']]),
 *   'conf.d/api-ssl.conf',
 * )
 * // output
 * 'server {\n  listen 443 ssl;\n}\n'
 */
export function findDumpedFile(
  files: Map<string, string>,
  relativePath: string,
): string | undefined {
  const suffix = `/${relativePath}`;
  for (const [path, content] of files) {
    if (path === relativePath || path.endsWith(suffix)) return content;
  }
  return undefined;
}
