import { describe, expect, it } from "vitest";
import type { RoadConditionRouteImpact } from "../types/routing";
import { roadConditionRouteNotice } from "./roadConditionRouteImpact";

function impact(
  availability: RoadConditionRouteImpact["availability"],
  reasons: string[],
): RoadConditionRouteImpact {
  return { availability, evaluatedAt: "2026-09-30T07:00:00Z", validUntil: null, reasons };
}

describe("roadConditionRouteNotice", () => {
  it("says nothing without an assessment or when conditions were applied", () => {
    expect(roadConditionRouteNotice(undefined)).toBeNull();
    expect(roadConditionRouteNotice(impact("current", []))).toBeNull();
  });

  it("says nothing when no road condition was reported", () => {
    expect(roadConditionRouteNotice(impact("unavailable", ["no_road_condition_provider"]))).toBe(
      null,
    );
    expect(roadConditionRouteNotice(impact("unavailable", ["missing_current_evidence"]))).toBe(
      null,
    );
    expect(
      roadConditionRouteNotice(
        impact("unsupported", ["no_road_condition_provider", "unverified_engine_application"]),
      ),
    ).toBeNull();
  });

  it("flags reported conditions the route may not reflect", () => {
    expect(roadConditionRouteNotice(impact("limited", ["legacy_geometry_unverified"]))).toBe(
      "notApplied",
    );
    expect(
      roadConditionRouteNotice(
        impact("unsupported", ["missing_routing_evidence", "unverified_engine_application"]),
      ),
    ).toBe("notApplied");
  });

  it("flags stale condition data and a provider that failed to answer", () => {
    expect(roadConditionRouteNotice(impact("expired", ["evidence_expired"]))).toBe("outdated");
    expect(
      roadConditionRouteNotice(impact("unavailable", ["road_condition_provider_unavailable"])),
    ).toBe("checkFailed");
    expect(
      roadConditionRouteNotice(
        impact("unsupported", [
          "road_condition_provider_unavailable",
          "unverified_engine_application",
        ]),
      ),
    ).toBe("checkFailed");
  });
});
