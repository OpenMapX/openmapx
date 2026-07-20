import { describe, expect, it } from "vitest";
import { availStateOf } from "./DataSourceLayer";

describe("availStateOf", () => {
  it("returns available when some chargers are free", () => {
    expect(availStateOf({ availability: { available: 1, total: 4 } })).toBe("available");
  });

  it("returns busy when none are free", () => {
    expect(availStateOf({ availability: { available: 0, total: 4 } })).toBe("busy");
  });

  it("returns unknown when there is no live availability data", () => {
    expect(availStateOf({})).toBe("unknown");
  });

  it("returns unknown when total is zero", () => {
    expect(availStateOf({ availability: { available: 0, total: 0 } })).toBe("unknown");
  });
});
