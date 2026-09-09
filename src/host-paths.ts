import { join } from 'node:path';
import { repoPaths } from './repo-paths.js';

/**
 * Translating paths between this process and the docker host.
 *
 * Separate from the repoPaths constants table because this is logic with a real
 * failure mode, not a lookup: getting it wrong disables the validation gate
 * silently rather than loudly.
 */

/**
 * Translates a path inside this repo to its equivalent on the docker host.
 *
 * Bind-mount sources are resolved by the docker daemon, which always runs on the
 * host. When vpsctl is itself containerised (see bin/vpsctl) its own paths are
 * meaningless to the daemon, and docker does not error on an unknown source: it
 * creates an empty directory and mounts that. A validator fed an empty config
 * directory reports success, so getting this wrong silently disables the gate
 * rather than breaking loudly.
 *
 * bin/vpsctl passes the host repo path in VPSCTL_HOST_REPO_DIR. Unset means
 * vpsctl is running directly on the host, where no translation is needed.
 */
export function hostPathForScratch(pathInsideRepo: string): string {
  const hostRepoDir = process.env['VPSCTL_HOST_REPO_DIR'];
  if (hostRepoDir === undefined || hostRepoDir === '') return pathInsideRepo;
  if (!pathInsideRepo.startsWith(repoPaths.root)) {
    throw new Error(
      `Cannot translate ${pathInsideRepo} to a host path: it is outside ${repoPaths.root}`,
    );
  }
  return join(hostRepoDir, pathInsideRepo.slice(repoPaths.root.length));
}

/**
 * Where a rendered file goes on the host.
 *
 * The renderer keys files by their path relative to the nginx config root
 * (`conf.d/...`, `snippets/...`) because that mirrors the layout inside the
 * container. On the host those two roots are separate directories, configured
 * independently, so the mapping happens here rather than in the renderer.
 */
export function hostPathFor(
  relativePath: string,
  paths: { nginxConfDir: string; snippetsDir: string },
): string {
  if (relativePath.startsWith('conf.d/')) {
    return join(paths.nginxConfDir, relativePath.slice('conf.d/'.length));
  }
  if (relativePath.startsWith('snippets/')) {
    return join(paths.snippetsDir, relativePath.slice('snippets/'.length));
  }
  throw new Error(`Rendered file has no host location: ${relativePath}`);
}
