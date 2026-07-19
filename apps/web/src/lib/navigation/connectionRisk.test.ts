import type { TripLeg } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { connectionRisk, itineraryTransferRisk } from "./connectionRisk";

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

function transitLeg(scheduledEndTime: string, scheduledStartTime: string): TripLeg {
  return {
    mode: "rail",
    startTime: scheduledStartTime,
    endTime: scheduledEndTime,
    scheduledStartTime,
    scheduledEndTime,
    from: { name: "A", lat: 0, lng: 0 },
    to: { name: "B", lat: 0, lng: 0 },
    route: { shortName: "RE1", longName: "", color: undefined },
    geometry: { type: "LineString", coordinates: [] },
  };
}

describe("itineraryTransferRisk", () => {
  const iso = (min: number) => new Date(base + min * 60_000).toISOString();

  it("flags the tightest scheduled transfer", () => {
    // leg A arrives at +10; leg B departs at +12 → 2 min scheduled buffer.
    const legs = [transitLeg(iso(10), iso(0)), transitLeg(iso(40), iso(12))];
    const risk = itineraryTransferRisk(legs);
    expect(risk?.level).toBe("tight");
    expect(risk?.bufferSeconds).toBe(120);
  });

  it("returns null when every change has comfortable slack", () => {
    const legs = [transitLeg(iso(10), iso(0)), transitLeg(iso(40), iso(25))];
    expect(itineraryTransferRisk(legs)).toBeNull();
  });
});
