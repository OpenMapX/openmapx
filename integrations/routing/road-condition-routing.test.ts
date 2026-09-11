import type { RoadConditionEvent } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { assessRoadConditionForRoute } from "./road-condition-routing.js";

const NOW = Date.parse("2026-09-12T12:00:00Z");

function event(overrides: Partial<RoadConditionEvent> = {}): RoadConditionEvent {
  return {
    id: "oc:1",
    source: "oc-child",
    provider: "road-conditions-openconditions",
    type: "road_closure",
    severity: "high",
    geometry: { type: "Point", coordinates: [7, 50] },
    headline: "Closed",
    originKind: "feed",
    routingEvidence: {
      schema_version: 1,
      observation_revision: "obs-1",
      binding_revision: "obs-1",
      graph_generation: "graph-1",
      resolver_version: "resolver-1",
      source_id: "oc-parent",
      child_source_id: "oc-child",
      source_license: "CC BY 4.0",
      license_url: "https://example.test/license",
      attribution: "Example road authority",
      record_url: null,
      source_checked_at: "2026-09-12T11:55:00Z",
      fresh_until: "2026-09-12T12:05:00Z",
      expires_at: "2026-09-12T12:10:00Z",
      valid_from: "2026-09-12T11:00:00Z",
      valid_to: "2026-09-12T13:00:00Z",
      next_transition_at: null,
      direction_mode: "both",
      applicability: { kind: "all" },
      rights: {
        source_redistribution: "yes",
        derived_redistribution: "yes",
        commercial_use: "yes",
        attribution_required: "yes",
        retention: "yes",
        evidence_origin: "source-catalogue",
        evidence_version: "1",
        reviewed_at: "2026-09-01T00:00:00Z",
      },
      segments: [
        { segment_id: "way:1:f", direction: "forward", from_fraction: 0, to_fraction: 1 },
        { segment_id: "way:1:r", direction: "reverse", from_fraction: 0, to_fraction: 1 },
      ],
      binding_status: "exact",
      reason_codes: [],
      evaluated_at: "2026-09-12T11:55:00Z",
    },
    ...overrides,
  };
}

describe("assessRoadConditionForRoute", () => {
  it("refuses raw geometry fallback for graph evidence without a proven engine receipt", () => {
    expect(
      assessRoadConditionForRoute(event(), {
        evaluatedAt: NOW,
        travelAt: NOW,
        mode: "driving",
        sharedTrafficApplied: false,
      }),
    ).toEqual({
      disposition: "ignore",
      reasons: ["unverified_engine_application"],
      validUntil: "2026-09-12T12:05:00.000Z",
    });
  });

  it("uses a proven current shared-traffic receipt only for motorised immediate routing", () => {
    expect(
      assessRoadConditionForRoute(event(), {
        evaluatedAt: NOW,
        travelAt: NOW,
        mode: "driving",
        sharedTrafficApplied: true,
      }),
    ).toEqual({
      disposition: "shared-traffic",
      reasons: [],
      validUntil: "2026-09-12T12:05:00.000Z",
    });

    expect(
      assessRoadConditionForRoute(event(), {
        evaluatedAt: NOW,
        travelAt: NOW + 60_000,
        mode: "driving",
        sharedTrafficApplied: true,
      }).reasons,
    ).toContain("unsupported_future_shared_traffic");
    expect(
      assessRoadConditionForRoute(event(), {
        evaluatedAt: NOW,
        travelAt: NOW,
        mode: "cycling",
        sharedTrafficApplied: true,
      }).reasons,
    ).toContain("unsupported_mode");
  });

  it("keeps an unbound legacy provider on the explicit limited geometry path", () => {
    const legacy = event({
      provider: "road-conditions-legacy",
      source: "legacy",
      originKind: undefined,
      routingEvidence: undefined,
      binding: undefined,
    });

    expect(
      assessRoadConditionForRoute(legacy, {
        evaluatedAt: NOW,
        travelAt: NOW,
        mode: "driving",
        sharedTrafficApplied: false,
        allowLegacyGeometry: true,
      }),
    ).toEqual({
      disposition: "legacy-geometry",
      reasons: ["legacy_geometry_unverified"],
      validUntil: null,
    });
  });

  it("does not classify an explicitly graph-bound event as legacy when evidence is missing", () => {
    const missing = event({ routingEvidence: undefined, binding: { status: "exact" } });
    expect(
      assessRoadConditionForRoute(missing, {
        evaluatedAt: NOW,
        travelAt: NOW,
        mode: "driving",
        sharedTrafficApplied: false,
        allowLegacyGeometry: true,
      }),
    ).toEqual({
      disposition: "ignore",
      reasons: ["missing_routing_evidence"],
      validUntil: null,
    });
  });
});
