import type { RoadConditionEvent } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { assessRoadConditionForRoute } from "./road-condition-routing.js";

const NOW = Date.parse("2026-09-12T12:00:00Z");

/**
 * A published restriction envelope. The route gate keys on *presence* of a
 * restriction claim, so this only has to be a well-formed envelope; host-side
 * validation of its contents is covered in @openmapx/core.
 */
function publishedRestriction(): NonNullable<RoadConditionEvent["restrictionDetails"]> {
  return {
    schemaVersion: 1,
    vehicleScope: "specific",
    completeness: "complete",
    issues: [],
    source: {
      sourceId: "fi-digitraffic",
      recordId: "GUID50465935",
      recordVersion: "31",
      sourceUpdatedAt: "2026-08-28T04:18:02.629Z",
      feedUrls: ["https://tie.digitraffic.fi/api/traffic-message/v2/roadworks"],
      publisher: "Fintraffic / Digitraffic",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Fintraffic / Digitraffic",
      modificationNotice:
        "Normalized by OpenConditions; source units and structure may be transformed.",
    },
    facts: [
      {
        id: "GUID50465935:GUID50469933:roadwork_phase:restrictions[2]",
        kind: "dimension",
        dimension: "gross_weight",
        meaning: "maximum_permitted",
        value: 26000,
        unit: "kg",
        operator: "lte",
        state: "active",
        scope: {
          kind: "roadwork_phase",
          phaseId: "GUID50469933",
          locationDescription: null,
          sourceLocationRefs: { scheme: "digitraffic_road_address", road: 104 },
          restrictionBinding: "not_established",
        },
        direction: { basis: "road_reference", value: "both", description: null },
        validFrom: "2026-07-19T21:00:00.000Z",
        validTo: "2026-12-14T21:59:59.999Z",
        sourceTokens: { type: "vehicle gross weight limit", quantity: 26, unit: "t" },
        context: {
          restrictionsLiftable: false,
          compliance: "unknown",
          operatorActionStatus: null,
          validityStatus: null,
        },
      },
    ],
    evaluatedAt: "2026-09-12T12:00:00.000Z",
    sourceCheckedAt: "2026-09-12T11:59:00.000Z",
    freshUntil: "2026-09-12T12:09:00.000Z",
    nextTransitionAt: "2026-12-14T21:59:59.999Z",
    isStale: false,
  };
}

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

  it("ignores a restriction-bearing event whatever the engine claims", () => {
    const details = publishedRestriction();
    for (const carrier of [
      { restrictionDetails: details },
      { restrictionDetailsUnsupported: true as const },
    ]) {
      expect(
        assessRoadConditionForRoute(event(carrier), {
          evaluatedAt: NOW,
          travelAt: NOW,
          mode: "driving",
          sharedTrafficApplied: true,
        }),
      ).toEqual({
        disposition: "ignore",
        reasons: ["vehicle_specific_restriction"],
        validUntil: null,
      });
    }
  });

  it("ignores a restriction-bearing event on the legacy-geometry path as well", () => {
    expect(
      assessRoadConditionForRoute(
        event({ routingEvidence: undefined, restrictionDetails: publishedRestriction() }),
        {
          evaluatedAt: NOW,
          travelAt: NOW,
          mode: "driving",
          sharedTrafficApplied: false,
          allowLegacyGeometry: true,
        },
      ).disposition,
    ).toBe("ignore");
  });

  it("still applies an unconditional closure with valid evidence", () => {
    expect(
      assessRoadConditionForRoute(event(), {
        evaluatedAt: NOW,
        travelAt: NOW,
        mode: "driving",
        sharedTrafficApplied: true,
      }).disposition,
    ).toBe("shared-traffic");
  });
});
