import { describe, expect, it } from "vitest";
import { connectionRisk } from "./connectionRisk";

const base = new Date("2026-07-15T10:00:00Z").getTime();

describe("connectionRisk", () => {
  it("is ok with a comfortable buffer", () => {
    // Arrive 10:00, depart 10:10, 2 min walk → 8 min spare.
    const r = connectionRisk({
      currentArrivalMs: base,
      nextDepartureMs: base + 10 * 60_000,
      transferWalkSeconds: 120,
    });
    expect(r.level).toBe("ok");
    expect(r.bufferSeconds).toBe(480);
  });

  it("is tight when the spare time is under two minutes", () => {
    const r = connectionRisk({
      currentArrivalMs: base,
      nextDepartureMs: base + 3 * 60_000,
      transferWalkSeconds: 120,
    });
    expect(r.level).toBe("tight");
    expect(r.bufferSeconds).toBe(60);
  });

  it("is missed when the walk overruns the departure", () => {
    const r = connectionRisk({
      currentArrivalMs: base,
      nextDepartureMs: base + 60_000,
      transferWalkSeconds: 120,
    });
    expect(r.level).toBe("missed");
    expect(r.bufferSeconds).toBe(-60);
  });

  it("returns ok when a time is unknown", () => {
    expect(
      connectionRisk({
        currentArrivalMs: Number.NaN,
        nextDepartureMs: base,
        transferWalkSeconds: 60,
      }),
    ).toEqual({ bufferSeconds: 0, level: "ok" });
  });
});
