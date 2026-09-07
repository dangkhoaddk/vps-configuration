import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locations inside this repo. Resolved from the compiled module rather than the
 * working directory, so `vpsctl` behaves the same wherever it is invoked from.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const repoPaths = {
  root: REPO_ROOT,
  registry: join(REPO_ROOT, 'apps.yml'),
  templates: join(REPO_ROOT, 'templates'),
  baseline: join(REPO_ROOT, 'baseline/from-deploy-scripts'),
  composeFile: join(REPO_ROOT, 'stack/compose.edge.yml'),
  composeEnvFile: join(REPO_ROOT, 'stack/.env'),
  renderedOutput: join(REPO_ROOT, 'rendered'),
  /**
   * Scratch space for trees that get bind-mounted into other containers.
   *
   * Deliberately inside the repo rather than os.tmpdir(). When vpsctl runs in a
   * container, the repo is the one directory with a known host counterpart, so
   * it is the only place a scratch path can be translated back for the docker
   * daemon. See hostPathForScratch.
   */
  scratch: join(REPO_ROOT, '.vpsctl-scratch'),
} as const;

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
  if (!pathInsideRepo.startsWith(REPO_ROOT)) {
    throw new Error(
      `Cannot translate ${pathInsideRepo} to a host path: it is outside ${REPO_ROOT}`,
    );
  }
  return join(hostRepoDir, pathInsideRepo.slice(REPO_ROOT.length));
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
