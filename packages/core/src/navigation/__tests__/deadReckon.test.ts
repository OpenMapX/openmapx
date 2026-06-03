import { describe, expect, it } from "vitest";
import type { LngLat } from "../../types/geometry";
import { cumulativeDistances, positionAt, stepDeadReckon } from "../deadReckon";

// Route running due east along the equator: three vertices ~222 m apart.
const geometry: LngLat[] = [
  [0, 0],
  [0.002, 0],
  [0.004, 0],
];

describe("cumulativeDistances", () => {
  it("accumulates great-circle distance to each vertex", () => {
    const cum = cumulativeDistances(geometry);
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeCloseTo(222.4, 0);
    expect(cum[2]).toBeCloseTo(444.8, 0);
  });
});

describe("positionAt", () => {
  const cum = cumulativeDistances(geometry);

  it("interpolates within a segment", () => {
    const { point } = positionAt(geometry, cum, cum[1] / 2);
    expect(point[0]).toBeCloseTo(0.001, 6);
    expect(point[1]).toBeCloseTo(0, 6);
  });

  it("reports the travel bearing of the segment (~90° due east)", () => {
    const { bearing } = positionAt(geometry, cum, 100);
    expect(bearing).toBeCloseTo(90, 0);
  });

  it("clamps past the end to the final vertex", () => {
    const { point } = positionAt(geometry, cum, 99999);
    expect(point[0]).toBeCloseTo(0.004, 6);
  });

  it("clamps negative distance to the start", () => {
    const { point } = positionAt(geometry, cum, -50);
    expect(point[0]).toBeCloseTo(0, 6);
  });
});

describe("stepDeadReckon", () => {
  const opts = { tauSeconds: 0.45, maxLeadSeconds: 1.5, routeLengthMeters: 1000 };

  it("eases toward a stationary target without overshooting", () => {
    // ~3 s of 60fps frames — several time constants — converges to the target.
    let displayed = 0;
    for (let i = 0; i < 180; i++) {
      displayed = stepDeadReckon(
        displayed,
        { fixAlongMeters: 100, speedMps: 0, ageSeconds: 0 },
        1 / 60,
        opts,
      );
    }
    expect(displayed).toBeGreaterThan(99);
    expect(displayed).toBeLessThanOrEqual(100);
  });

  it("glides forward between fixes by dead-reckoning at the fix speed", () => {
    // Displayed already at the fix; with speed the target leads forward, so the
    // displayed distance advances even though no new fix has arrived.
    const before = 100;
    const after = stepDeadReckon(
      before,
      { fixAlongMeters: 100, speedMps: 10, ageSeconds: 0.5 },
      1 / 60,
      opts,
    );
    expect(after).toBeGreaterThan(before);
  });

  it("caps how far ahead it predicts", () => {
    // age far beyond maxLeadSeconds must not project past fix + speed*maxLead.
    let displayed = 100;
    for (let i = 0; i < 120; i++) {
      displayed = stepDeadReckon(
        displayed,
        { fixAlongMeters: 100, speedMps: 10, ageSeconds: 10 },
        1 / 60,
        opts,
      );
    }
    // Converges toward 100 + 10 * 1.5 = 115, never beyond.
    expect(displayed).toBeLessThanOrEqual(115 + 1e-6);
    expect(displayed).toBeGreaterThan(114);
  });

  it("eases gently down on deceleration instead of jumping back", () => {
    // Predicted ahead at 130; a slowing fix lands behind at 110. One frame must
    // only nudge back a little, never teleport to the new value.
    const displayed = 130;
    const next = stepDeadReckon(
      displayed,
      { fixAlongMeters: 110, speedMps: 0, ageSeconds: 0 },
      1 / 60,
      opts,
    );
    expect(next).toBeLessThan(displayed);
    expect(next).toBeGreaterThan(125); // moved back < ~5 m in one 60fps frame
  });

  it("clamps to the route length", () => {
    const next = stepDeadReckon(
      995,
      { fixAlongMeters: 2000, speedMps: 50, ageSeconds: 5 },
      1,
      opts,
    );
    expect(next).toBeLessThanOrEqual(1000);
  });
});
