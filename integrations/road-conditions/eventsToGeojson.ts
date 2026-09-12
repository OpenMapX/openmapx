import type { RoadConditionEvent } from "./types.js";

interface RoadConditionFeature {
  type: "Feature";
  id: string;
  geometry: RoadConditionEvent["geometry"];
  properties: Record<string, unknown>;
}

export interface RoadConditionFeatureCollection {
  type: "FeatureCollection";
  features: RoadConditionFeature[];
}

/**
 * Serializes road-condition events into the GeoJSON FeatureCollection the
 * declarative overlay (and the nav client) consume. Property names are the
 * overlay's styling/popup contract: `severity` (paint), `type`/`headline`/
 * `description` (popup).
 */
export function eventsToFeatureCollection(
  events: RoadConditionEvent[],
): RoadConditionFeatureCollection {
  return {
    type: "FeatureCollection",
    features: events.map((e) => ({
      type: "Feature" as const,
      id: e.id,
      geometry: e.geometry,
      properties: {
        id: e.id,
        source: e.source,
        sourceRecords: e.sourceRecords ?? null,
        provider: e.provider,
        ...(e.groupId ? { groupId: e.groupId } : {}),
        type: e.type,
        severity: e.severity,
        headline: e.headline,
        description: e.description ?? null,
        delaySeconds: e.delaySeconds ?? null,
        roadState: e.roadState ?? null,
        roads: e.roads ?? null,
        validFrom: e.validFrom ?? null,
        validTo: e.validTo ?? null,
        schedule: e.schedule ?? null,
        dataUpdatedAt: e.dataUpdatedAt ?? null,
        binding: e.binding ?? null,
        vehiclesAffected: e.vehiclesAffected ?? null,
        routingEvidence: e.routingEvidence ?? null,
        expiresAt: e.expiresAt ?? null,
        isStale: e.isStale ?? null,
        attribution: e.attribution ?? null,
        // Evidence provenance — carried to the overlay so a crowd/unconfirmed
        // report can be labeled distinctly (see `isUnconfirmedCrowd`). Absent
        // for official third-party providers that don't set them.
        originKind: e.originKind ?? null,
        evidenceState: e.evidenceState ?? null,
        routingEligible: e.routingEligible ?? null,
        confidenceScore: e.confidenceScore ?? null,
        // Planned-works labeling — the overlay dims/dashes works that have not
        // started yet, and shows their start date in the popup.
        isForecast: e.isForecast ?? null,
        isPlanned: e.isPlanned ?? null,
        ...(e.subtype ? { subtype: e.subtype } : {}),
        // Both restriction fields travel verbatim. `restrictionDetails: null`
        // would read as a present-but-unreadable claim on the way back in, so
        // an event with no claim carries neither key.
        ...(e.restrictionDetails !== undefined ? { restrictionDetails: e.restrictionDetails } : {}),
        ...(e.restrictionDetailsUnsupported === true
          ? { restrictionDetailsUnsupported: true }
          : {}),
      },
    })),
  };
}
