import { describe, expect, it } from "vitest";
import {
  deriveFreeSpaces,
  mapState,
  mapUtmcPayload,
  mergeUtmcLive,
} from "../utmc-newcastle-mapper.js";

describe("mapState", () => {
  it("maps CLOSED and FAULTY to closed", () => {
    expect(mapState("CLOSED")).toBe("closed");
    expect(mapState("FAULTY")).toBe("closed");
  });
  it("maps SPACES / ALMOST FULL / FULL / OPEN to open", () => {
    for (const s of ["SPACES", "ALMOST FULL", "FULL", "OPEN"]) {
      expect(mapState(s)).toBe("open");
    }
  });
  it("returns unknown otherwise", () => {
    expect(mapState()).toBe("unknown");
    expect(mapState("UNKNOWN")).toBe("unknown");
    expect(mapState("WAT")).toBe("unknown");
  });
});

describe("deriveFreeSpaces", () => {
  it("returns capacity - occupancy when both present", () => {
    expect(deriveFreeSpaces(50, 200)).toBe(150);
  });
  it("clamps negative results to 0", () => {
    expect(deriveFreeSpaces(250, 200)).toBe(0);
  });
  it("returns undefined when either side is missing", () => {
    expect(deriveFreeSpaces(undefined, 200)).toBeUndefined();
    expect(deriveFreeSpaces(50, undefined)).toBeUndefined();
  });
});

describe("mapUtmcPayload", () => {
  it("builds a ParkingFacility with utmc: prefix and static fields", () => {
    const facility = mapUtmcPayload("CP1", {
      coordinates: [-1.625, 54.975],
      name: "Town Centre",
      capacity: 200,
      address: "Car park in Newcastle Town Centre",
      parkingType: "garage",
      fee: "unknown",
      staticDataUpdatedAt: "2012-01-13T12:19:32.419+0000",
    });
    expect(facility).toMatchObject({
      id: "utmc:CP1",
      name: "Town Centre",
      coordinates: [-1.625, 54.975],
      sources: ["utmc-newcastle"],
      parkingType: "garage",
      capacity: 200,
      hasRealtimeData: false,
      staticDataUpdatedAt: "2012-01-13T12:19:32.419+0000",
      dataUpdatedAt: "2012-01-13T12:19:32.419+0000",
      fee: "unknown",
      address: "Car park in Newcastle Town Centre",
      state: "unknown",
    });
  });

  it("defaults gracefully when payload is empty", () => {
    const facility = mapUtmcPayload("CPX", {});
    expect(facility.id).toBe("utmc:CPX");
    expect(facility.name).toBe("Car Park CPX");
    expect(facility.coordinates).toEqual([0, 0]);
    expect(facility.parkingType).toBe("garage");
    expect(facility.hasRealtimeData).toBe(false);
  });
});

describe("mergeUtmcLive", () => {
  const base = mapUtmcPayload("CP1", {
    coordinates: [-1.625, 54.975],
    name: "Town Centre",
    capacity: 200,
    parkingType: "garage",
    fee: "unknown",
    staticDataUpdatedAt: "2012-01-13T12:19:32.419+0000",
  });

  it("derives freeSpaces, state, and updates realtime/data timestamps", () => {
    const merged = mergeUtmcLive(base, {
      asOf: "2012-01-13T12:19:32.419+0000",
      occupancy: 142,
      stateDescription: "SPACES",
    });
    expect(merged.freeSpaces).toBe(58);
    expect(merged.state).toBe("open");
    expect(merged.hasRealtimeData).toBe(true);
    expect(merged.realtimeDataUpdatedAt).toBe("2012-01-13T12:19:32.419+0000");
    expect(merged.dataUpdatedAt).toBe("2012-01-13T12:19:32.419+0000");
  });

  it("returns base unchanged when live is null", () => {
    expect(mergeUtmcLive(base, null)).toBe(base);
  });

  it("maps CLOSED state and leaves freeSpaces undefined when occupancy missing", () => {
    const merged = mergeUtmcLive(base, {
      asOf: "2012-01-13T12:19:32.419+0000",
      stateDescription: "CLOSED",
    });
    expect(merged.state).toBe("closed");
    expect(merged.freeSpaces).toBeUndefined();
    expect(merged.hasRealtimeData).toBe(true);
  });
});
