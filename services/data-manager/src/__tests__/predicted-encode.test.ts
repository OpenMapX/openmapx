import { describe, expect, it } from "vitest";
import {
  encodePredictedSpeeds,
  expandHourlyToBuckets,
  roundHalfAwayFromZero,
} from "../jobs/traffic/predicted-encode.js";
import fixtures from "./fixtures/predicted-speeds.json" with { type: "json" };

describe("roundHalfAwayFromZero", () => {
  it("rounds half away from zero (matching C++ roundf, not JS Math.round)", () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
    expect(roundHalfAwayFromZero(-2.6)).toBe(-3);
  });
});

describe("expandHourlyToBuckets", () => {
  it("expands 168 hourly values into 2016 five-minute buckets", () => {
    const buckets = expandHourlyToBuckets(fixtures.rush.hourly_day, fixtures.rush.freeFlow);
    expect(buckets).toHaveLength(2016);
  });

  it("repeats each hourly value across its 12 five-minute buckets (Sunday-first)", () => {
    // hourly_day is one day repeated for all 7 days in the fixture generator;
    // Monday 08:00 -> index 288*1 + 12*8 = 384, hourly_day[8] = 45.
    const hourly = Array<number | null>(168).fill(0);
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) hourly[24 * d + h] = fixtures.rush.hourly_day[h];
    }
    const buckets = expandHourlyToBuckets(hourly, fixtures.rush.freeFlow);
    expect(buckets[384]).toBe(45);
    // whole hour block (12 buckets) shares the same value
    for (let k = 0; k < 12; k++) expect(buckets[384 + k]).toBe(45);
  });

  it("falls back to freeFlow for a null hour", () => {
    const hourly = Array<number | null>(168).fill(30);
    hourly[24 * 1 + 8] = null; // Monday 08:00
    const buckets = expandHourlyToBuckets(hourly, 90);
    const idx = 288 * 1 + 12 * 8;
    for (let k = 0; k < 12; k++) expect(buckets[idx + k]).toBe(90);
  });

  it("clamps values to [5, 140]", () => {
    const hourly = Array<number | null>(168).fill(200);
    hourly[0] = 1;
    const buckets = expandHourlyToBuckets(hourly, 50);
    expect(buckets[0]).toBe(5);
    expect(buckets[12]).toBe(140);
  });
});

describe("encodePredictedSpeeds", () => {
  it("matches pyvalhalla exactly for an all-50 flat week", () => {
    expect(encodePredictedSpeeds(fixtures.all50.buckets2016)).toBe(fixtures.all50.base64);
  });

  it("matches pyvalhalla exactly for the rush-hour week", () => {
    expect(encodePredictedSpeeds(fixtures.rush.buckets2016)).toBe(fixtures.rush.base64);
  });
});
