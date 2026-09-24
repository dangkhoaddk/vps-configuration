import { describe, expect, it } from 'vitest';
import { ACCEPTED_DIVERGENCES, applyAcceptedDivergences } from './accepted-divergences.js';

/**
 * The exception layer is what keeps the parity gate honest while the live
 * capture stays unedited. If it ever fails open, every difference it covers
 * stops being checked and nothing says so.
 */
describe('accepted divergences', () => {
  it('leaves a file with no recorded divergence alone', () => {
    const config = 'server {\n    listen 443 ssl;\n}';
    expect(applyAcceptedDivergences('conf.d/web-ssl.conf', config)).toBe(config);
  });

  it('throws rather than no-opping when the anchor is gone', () => {
    // A baseline recaptured after a divergence landed would otherwise make the
    // patch silently do nothing, and the comparison would still pass.
    expect(() => applyAcceptedDivergences('conf.d/http.conf', 'server {\n    listen 80;\n}')).toThrow(
      /no longer matches the baseline/,
    );
  });

  it('names the file and the reason when it throws', () => {
    expect(() => applyAcceptedDivergences('conf.d/upstreams.conf', 'nothing to match')).toThrow(
      /conf\.d\/upstreams\.conf/,
    );
  });

  it('records a reason for every divergence', () => {
    // An entry without a stated reason is an unexplained hole in the gate.
    for (const [path, divergences] of Object.entries(ACCEPTED_DIVERGENCES)) {
      for (const divergence of divergences) {
        expect(divergence.reason.length, `${path} has a divergence with no reason`).toBeGreaterThan(
          20,
        );
      }
    }
  });
});
