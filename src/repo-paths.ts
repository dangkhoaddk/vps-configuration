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
   * daemon. See hostPathForScratch in host-paths.ts.
   */
  scratch: join(REPO_ROOT, '.vpsctl-scratch'),
  /**
   * Held while mutating nginx config or requesting certificates.
   *
   * Inside the repo because bin/vpsctl bind-mounts the repo, so a containerised
   * run and a host run contend on the same inode.
   */
  lock: join(REPO_ROOT, '.vpsctl.lock'),
} as const;
