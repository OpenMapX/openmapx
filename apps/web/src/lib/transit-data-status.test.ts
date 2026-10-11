import type { Freshness } from "@openmapx/mobility-core/freshness";
import type { Departure } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import { departureRealtimeEvidence, getTransitDataStatus } from "./transit-data-status";

const now = Date.parse("2026-10-07T08:00:00Z");
const base: Freshness = {
  fetchedAt: "2026-10-07T08:00:00Z",
  hasRealtimeData: true,
  isStale: false,
};

describe("transit source age and service evidence", () => {
  it("cannot infer working realtime or upstream age from a recent request and enabled provider", () => {
    expect(getTransitDataStatus({ freshness: base }, now)).toMatchObject({
      timing: "unknown",
      freshness: "unknown",
      ageSeconds: null,
    });
    expect(getTransitDataStatus({ realtime: true, freshness: base }, now)).toMatchObject({
      timing: "realtime",
      freshness: "unknown",
      ageSeconds: null,
    });
    expect(getTransitDataStatus({ realtime: false, freshness: base }, now).timing).toBe(
      "scheduled",
    );
  });
  it.each([
    [90, "fresh"],
    [91, "stale"],
  ] as const)("uses the upstream trip-update age at %ss", (age, status) => {
    const dataAsOf = new Date(now - age * 1000).toISOString();
    expect(
      getTransitDataStatus({ realtime: true, freshness: { ...base, dataAsOf } }, now),
    ).toMatchObject({ freshness: status, ageSeconds: age });
  });
  it.each([undefined, "not-a-date", "2026-10-07T08:00:01Z"])(
    "keeps missing, invalid and future upstream time %s unknown",
    (dataAsOf) => {
      expect(
        getTransitDataStatus({ realtime: true, freshness: { ...base, dataAsOf } }, now),
      ).toMatchObject({ freshness: "unknown", ageSeconds: null });
    },
  );
  it("does not substitute static data age or a successful prior fetch after a failed refresh", () => {
    const dataAsOf = "2026-10-07T07:59:30Z";
    expect(
      getTransitDataStatus(
        { realtime: true, freshness: { ...base, dataAsOf, hasRealtimeData: false } },
        now,
      ).freshness,
    ).toBe("unknown");
    expect(
      getTransitDataStatus(
        { realtime: true, freshness: { ...base, dataAsOf }, queryFailed: true },
        now,
      ),
    ).toMatchObject({ freshness: "unknown", failed: true });
    expect(
      getTransitDataStatus({ realtime: true, freshness: { ...base, dataAsOf, isStale: true } }, now)
        .freshness,
    ).toBe("stale");
  });
  it("keeps source path and incomplete coverage separate from freshness", () => {
    expect(
      getTransitDataStatus(
        { source: "transit-motis-local", freshness: { ...base, isPartial: true } },
        now,
      ),
    ).toMatchObject({ source: "local", partial: true });
    expect(getTransitDataStatus({ source: "mo" }, now).source).toBe("hosted");
    expect(getTransitDataStatus({ source: "legacy" }, now).source).toBe("unknown");
  });
  it("does not call contradictory or legacy prediction metadata scheduled-only", () => {
    const dep = {
      provenance: { realtimeCompleteness: "none" },
      expectedAt: "2026-10-07T08:03:00Z",
    } as Departure;
    expect(departureRealtimeEvidence(dep)).toBeUndefined();
    expect(departureRealtimeEvidence({ ...dep, expectedAt: undefined })).toBe(false);
    expect(
      departureRealtimeEvidence({
        ...dep,
        provenance: {
          baselineSource: "gtfs",
          instance: "ms",
          observedAt: new Date(now).toISOString(),
          realtimeCompleteness: "merged",
        },
      }),
    ).toBe(true);
    expect(departureRealtimeEvidence({} as Departure)).toBeUndefined();
  });
});
