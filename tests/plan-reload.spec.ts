import { describe, expect, it } from 'vitest';
import { planReload } from '../src/commands/plan-reload.js';

/**
 * The regression this file exists for: on 2026-09-25 a web deploy recreated its
 * container, `apply --app web` rendered byte-identical config, reported
 * "no changes; nginx not reloaded", and the site served 502 for about eight
 * minutes. nginx was still proxying to the destroyed container's address,
 * because it resolves upstream hostnames at config-load time.
 *
 * The diff is not the only thing that invalidates what nginx has loaded.
 */
describe('planReload', () => {
  it('reloads when files changed', () => {
    expect(planReload(false, undefined).reload).toBe(true);
    expect(planReload(false, 'web').reload).toBe(true);
  });

  it('reloads on a no-op when an app asked for the apply', () => {
    // The app's pipeline calls this right after recreating its container, so a
    // no-op diff says nothing about whether the upstream address still resolves
    // to the same place.
    expect(planReload(true, 'web').reload).toBe(true);
  });

  it('names the app in the no-op reload message, so the log says why', () => {
    // "no changes; nginx not reloaded" was true and actively misleading.
    const { message } = planReload(true, 'web');
    expect(message).toContain('web');
    expect(message).toContain('re-resolve');
  });

  it('does not reload on a no-op with no app requested', () => {
    // Nobody is claiming a container moved, so there is nothing to re-resolve.
    const decision = planReload(true, undefined);
    expect(decision.reload).toBe(false);
    expect(decision.message).toBe('no changes; nginx not reloaded');
  });

  it.each(['api', 'web', 'admin'])('holds for every app: %s', (app) => {
    expect(planReload(true, app).reload).toBe(true);
  });
});
