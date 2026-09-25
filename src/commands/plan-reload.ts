/**
 * Decides whether nginx has to be reloaded, given what the render changed and
 * who asked for the apply.
 *
 * Pure, so the rule below can be checked without a docker daemon. The rule is
 * subtle enough that it cost a production outage before it was written down.
 */

export interface ReloadDecision {
  readonly reload: boolean;
  /** What to print. Says why, because "no changes" alone misled once already. */
  readonly message: string;
}

/**
 * **A render that changes nothing still needs a reload when an app asked for it.**
 *
 * `--app <name>` is passed by that app's deploy pipeline, immediately after it
 * has started or recreated its own container. A container that comes back on a
 * different address leaves nginx proxying to the address the old one had,
 * because nginx resolves upstream hostnames when it loads its config, not per
 * request. The rendered config is byte-identical in that case, so a decision
 * based on the diff alone reloads nothing, and the site serves 502 until
 * something else happens to reload nginx.
 *
 * The deploy scripts this repo replaced never hit it: they ended with an
 * unconditional `nginx -s reload` or a force-recreate. Dropping that was right,
 * but it was also doing something load-bearing that nothing replaced.
 *
 * A graceful reload costs nothing here. Existing connections finish on the old
 * workers, and an app deploy is already the disruptive event.
 *
 * Without `--app`, a no-op really is a no-op: nobody is claiming a container
 * just moved, so there is nothing to re-resolve.
 *
 * @example
 * // input
 * true, 'web'
 * // output
 * { reload: true, message: "no file changes, but reloading so nginx re-resolves web's upstream" }
 *
 * @example
 * // input
 * true, undefined
 * // output
 * { reload: false, message: 'no changes; nginx not reloaded' }
 */
export function planReload(noOp: boolean, requestedApp: string | undefined): ReloadDecision {
  if (!noOp) return { reload: true, message: '' };

  if (requestedApp !== undefined) {
    return {
      reload: true,
      message: `no file changes, but reloading so nginx re-resolves ${requestedApp}'s upstream`,
    };
  }

  return { reload: false, message: 'no changes; nginx not reloaded' };
}
