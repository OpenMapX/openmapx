import { describe, expect, it } from "vitest";
import { DEDUP, type DedupKey, TTL, type TTLClass } from "../policy.js";

describe("policy TTL", () => {
  it("every TTL is a positive integer number of seconds", () => {
    for (const [name, value] of Object.entries(TTL)) {
      expect(Number.isInteger(value), `${name} must be an integer`).toBe(true);
      expect(value, `${name} must be > 0`).toBeGreaterThan(0);
    }
  });

  it("REALTIME_HOT <= REALTIME_WARM <= VEHICLE_STATUS <= SCHEDULE <= STATIC_ARCHIVE", () => {
    expect(TTL.REALTIME_HOT).toBeLessThanOrEqual(TTL.REALTIME_WARM);
    expect(TTL.REALTIME_WARM).toBeLessThanOrEqual(TTL.VEHICLE_STATUS);
    expect(TTL.VEHICLE_STATUS).toBeLessThanOrEqual(TTL.SCHEDULE);
    expect(TTL.SCHEDULE).toBeLessThanOrEqual(TTL.STATIC_ARCHIVE);
  });

  it("SCHEDULE <= PLACE_LINK <= STATIC_ARCHIVE", () => {
    expect(TTL.PLACE_LINK).toBeGreaterThanOrEqual(TTL.SCHEDULE);
    expect(TTL.PLACE_LINK).toBeLessThanOrEqual(TTL.STATIC_ARCHIVE);
  });

  it("TTLClass type compiles for every key", () => {
    const keys = Object.keys(TTL) as TTLClass[];
    // satisfies-style check: keys is exhaustively typed as TTLClass[]
    const sample = keys[0] satisfies TTLClass;
    expect(typeof sample).toBe("string");
  });
});

describe("policy DEDUP", () => {
  it("every distance radius is a positive number of meters", () => {
    const radiusKeys: DedupKey[] = [
      "STOP_RADIUS_M",
      "STATION_RADIUS_M",
      "PARKING_RADIUS_M",
      "EV_RADIUS_M",
    ];
    for (const key of radiusKeys) {
      const v = DEDUP[key];
      expect(typeof v, `${key} must be number`).toBe("number");
      expect(v, `${key} must be > 0`).toBeGreaterThan(0);
    }
    expect(Number.isInteger(DEDUP.DEPARTURE_BUCKET_SECONDS)).toBe(true);
    expect(DEDUP.DEPARTURE_BUCKET_SECONDS).toBeGreaterThan(0);
  });

  it("name similarity floor lives in (0, 1]", () => {
    expect(DEDUP.NAME_SIMILARITY_MIN).toBeGreaterThan(0);
    expect(DEDUP.NAME_SIMILARITY_MIN).toBeLessThanOrEqual(1);
  });

  it("DedupKey type compiles for every key", () => {
    const keys = Object.keys(DEDUP) as DedupKey[];
    const sample = keys[0] satisfies DedupKey;
    expect(typeof sample).toBe("string");
  });
});
