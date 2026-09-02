import { describe, expect, it } from "vitest";
import type { ResolvedSchedule } from "./scheduleConstraints";
import {
  fidelityFor,
  requiredTemporalSemantics,
  resolveTemporalCapabilities,
  worstSupport,
} from "./temporalCapabilities";

function resolved(overrides: Partial<ResolvedSchedule> = {}): ResolvedSchedule {
  return {
    stops: [0, 1].map((index) => ({
      index,
      timeZone: "Europe/Berlin",
      earliestDepartureMs: null,
      latestArrivalMs: null,
      dwellSeconds: 0,
      dwellIgnored: false,
    })),
    anchorMs: 0,
    anchor: { kind: "now" },
    direction: "forward",
    violations: [],
    ...overrides,
  };
}

describe("worstSupport", () => {
  it("returns the lowest level present", () => {
    expect(worstSupport(["native", "emulated", "approximate"])).toBe("approximate");
    expect(worstSupport(["native", "native"])).toBe("native");
    expect(worstSupport(["emulated", "unsupported"])).toBe("unsupported");
  });

  it("treats an empty list as native", () => {
    expect(worstSupport([])).toBe("native");
  });
});

describe("fidelityFor", () => {
  it("collapses native and emulated to exact", () => {
    expect(fidelityFor("native")).toBe("exact");
    expect(fidelityFor("emulated")).toBe("exact");
    expect(fidelityFor("approximate")).toBe("approximate");
  });
});

describe("resolveTemporalCapabilities", () => {
  it("returns a declared block untouched", () => {
    const declared = {
      tripDepartAt: "native",
      tripArriveBy: "native",
      dwell: "native",
      waypointDepartAfter: "emulated",
      waypointArriveBy: "emulated",
      timeDependentTravel: "native",
    } as const;
    expect(resolveTemporalCapabilities({ temporal: declared })).toEqual(declared);
  });

  it("derives emulated waypoint semantics for an undeclared time-aware provider", () => {
    const derived = resolveTemporalCapabilities({ supportsTimeAware: true });
    expect(derived.tripDepartAt).toBe("native");
    expect(derived.timeDependentTravel).toBe("native");
    expect(derived.waypointDepartAfter).toBe("emulated");
    expect(derived.dwell).toBe("emulated");
  });

  it("derives approximate semantics for an undeclared time-agnostic provider", () => {
    const derived = resolveTemporalCapabilities({});
    expect(derived.timeDependentTravel).toBe("unsupported");
    expect(derived.dwell).toBe("approximate");
    expect(derived.tripArriveBy).toBe("approximate");
  });
});

describe("requiredTemporalSemantics", () => {
  it("asks for nothing on an unconstrained depart-now trip", () => {
    expect(requiredTemporalSemantics(resolved())).toEqual([]);
  });

  it("asks only for the trip-level pin on an ordinary timed trip", () => {
    expect(
      requiredTemporalSemantics(
        resolved({ anchor: { kind: "departAt", wallClock: "2026-09-01T09:00" } }),
      ),
    ).toEqual(["tripDepartAt"]);
  });

  it("asks for the trip arrival pin on a backward solve", () => {
    expect(
      requiredTemporalSemantics(
        resolved({
          anchor: { kind: "arriveBy", wallClock: "2026-09-01T18:00" },
          direction: "backward",
        }),
      ),
    ).toEqual(["tripArriveBy"]);
  });

  it("asks for dwell when any stop has one", () => {
    const input = resolved();
    input.stops[1].dwellSeconds = 600;
    expect(requiredTemporalSemantics(input)).toEqual(["dwell"]);
  });

  it("asks for each window semantic that appears", () => {
    const input = resolved();
    input.stops[0].earliestDepartureMs = 1;
    input.stops[1].latestArrivalMs = 2;
    expect(requiredTemporalSemantics(input).sort()).toEqual([
      "waypointArriveBy",
      "waypointDepartAfter",
    ]);
  });
});
