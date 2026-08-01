import { describe, expect, it } from "vitest";
import { FLOW_RATIO_STOPS, flowColorFor } from "../trafficFlowColors";

describe("flowColorFor", () => {
  it("colours by measured ratio when one is present", () => {
    expect(flowColorFor("heavy", 0)).toBe("#7e0023");
    expect(flowColorFor("free_flow", 1)).toBe("#2ecc40");
  });

  it("interpolates between ramp stops", () => {
    expect(flowColorFor("heavy", 0.5)).toBe("#ff8c00");
    // 0.5 is itself a declared stop, so it exercises no blending at all. 0.6
    // sits 40% of the way from #ff8c00 to #ffd500 — the green channel is the
    // only one that moves, 0x8c + (0xd5 - 0x8c) * 0.4 = 0xa9 — which is what
    // keeps the route's bands and the road overlay agreeing off-stop too.
    expect(flowColorFor("heavy", 0.6)).toBe("#ffa900");
  });

  it("falls back to the declared level when no ratio was measured", () => {
    expect(flowColorFor("queuing")).toBe("#e8112d");
    expect(flowColorFor("stationary")).toBe("#7e0023");
    expect(flowColorFor("heavy")).toBe("#ff8c00");
    expect(flowColorFor("free_flow")).toBe("#2ecc40");
    expect(flowColorFor("unknown")).toBe("#2ecc40");
  });

  it("keeps the ramp monotonic from jam to free flow", () => {
    expect(FLOW_RATIO_STOPS.map(([stop]) => stop)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
});
