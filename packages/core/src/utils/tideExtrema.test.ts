import { describe, expect, it } from "vitest";
import { despikeSeries, findTideExtrema } from "./tideExtrema";

// Synthesize a sampled sine with optional noise. `t` in hours.
function series(
  hours: number,
  stepMin: number,
  amplitude: number,
  periodH: number,
  noise = 0,
): { time: string; value: number }[] {
  const out: { time: string; value: number }[] = [];
  for (let m = 0; m <= hours * 60; m += stepMin) {
    const t = m / 60;
    const wobble = noise ? (((m * 9301 + 49297) % 233280) / 233280 - 0.5) * 2 * noise : 0;
    out.push({
      time: new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString(),
      value: amplitude * Math.sin((2 * Math.PI * t) / periodH) + wobble,
    });
  }
  return out;
}

describe("findTideExtrema", () => {
  it("finds the expected number of alternating extrema on a clean semidiurnal curve", () => {
    // 24h, 12.42h period → ~2 highs + ~2 lows; amplitude 1m.
    const extrema = findTideExtrema(series(24, 6, 1, 12.42), {
      minDelta: 0.03,
      relativeDelta: 0.1,
    });
    // ~2 cycles over 24h → a handful of extrema, not dozens.
    expect(extrema.length).toBeGreaterThanOrEqual(2);
    expect(extrema.length).toBeLessThanOrEqual(6);
    // strictly alternating
    for (let i = 1; i < extrema.length; i++) {
      expect(extrema[i].type).not.toBe(extrema[i - 1].type);
    }
  });

  it("rejects sensor noise instead of reporting dozens of micro-extrema", () => {
    // Same tide with 2cm noise sampled every minute (the bug's conditions).
    const noisy = series(24, 1, 1, 12.42, 0.02);
    const extrema = findTideExtrema(noisy, { minDelta: 0.03, relativeDelta: 0.1 });
    expect(extrema.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < extrema.length; i++) {
      expect(extrema[i].type).not.toBe(extrema[i - 1].type);
    }
  });

  it("emits a recent peak that sits near the end of the window (trailing extreme)", () => {
    // Descend to a trough, rise to a peak, then dip slightly — like a station's
    // past-24h ending just after a midday high (the Trieste/Poreč case).
    const pts: { time: string; value: number }[] = [];
    let m = 0;
    const push = (value: number) => {
      pts.push({ time: new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString(), value });
      m += 10;
    };
    for (let v = 0.5; v >= -1; v -= 0.1) push(Number(v.toFixed(2))); // down to trough
    for (let v = -0.9; v <= 1; v += 0.1) push(Number(v.toFixed(2))); // up to peak
    push(0.95);
    push(0.9); // small post-peak dip at the very end
    const extrema = findTideExtrema(pts, { minDelta: 0.03, relativeDelta: 0.12 });
    expect(extrema.map((e) => e.type)).toEqual(["L", "H"]);
  });

  it("despikeSeries removes a sentinel outlier so it doesn't spawn spurious extrema", () => {
    const clean = series(24, 6, 1, 12.42);
    const withSpike = clean.map((s, i) => (i === 20 ? { ...s, value: -1 } : s));
    const before = findTideExtrema(withSpike, { minDelta: 0.03, relativeDelta: 0.12 });
    const after = findTideExtrema(despikeSeries(withSpike, 0.25), {
      minDelta: 0.03,
      relativeDelta: 0.12,
    });
    // The spike injects spurious H/L around index 20; despiking removes them.
    expect(after.length).toBeLessThan(before.length);
    expect(despikeSeries(withSpike, 0.25)).toHaveLength(withSpike.length - 1);
  });

  it("never emits a high and a low at the same flat plateau", () => {
    const flat = Array.from({ length: 60 }, (_, m) => ({
      time: new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString(),
      value: -0.7,
    }));
    expect(findTideExtrema(flat, { minDelta: 0.03, relativeDelta: 0.1 })).toEqual([]);
  });
});
