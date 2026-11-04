import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oldestDataAsOf, upstreamDataAsOf } from "../src/types/freshness";

describe("upstreamDataAsOf", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    [1793448000 - 30, "2026-10-31T11:59:30.000Z"],
    ["2026-10-31T11:59:20.4654344Z", "2026-10-31T11:59:20.465Z"],
  ])("reads %j as an ISO timestamp", (value, expected) => {
    expect(upstreamDataAsOf(value)).toBe(expected);
  });

  it.each([null, undefined, "", "not a time", 1793448000 + 60])(
    "leaves %j unknown instead of guessing",
    (value) => {
      expect(upstreamDataAsOf(value)).toBeUndefined();
    },
  );
});

describe("oldestDataAsOf", () => {
  it("is the oldest stamp when every record has one", () => {
    expect(oldestDataAsOf(["2026-10-31T11:59:30.000Z", "2026-10-31T11:58:00.000Z"])).toBe(
      "2026-10-31T11:58:00.000Z",
    );
  });

  it.each([[[]], [["2026-10-31T11:59:30.000Z", undefined]]])("is unknown for %j", (stamps) => {
    expect(oldestDataAsOf(stamps)).toBeUndefined();
  });
});
