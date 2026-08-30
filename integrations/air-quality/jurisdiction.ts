import type { AirQualityCurrentResponse } from "@openmapx/air-quality";
import { resolveJurisdiction } from "@openmapx/air-quality/server";

import type { ParsedPointQuery } from "./query.js";

export type CanonicalJurisdiction = AirQualityCurrentResponse["jurisdiction"];

export function resolvePointJurisdiction(
  query: Pick<
    ParsedPointQuery,
    "latitude" | "longitude" | "evaluatedAt" | "countryCode" | "subdivisionCode"
  >,
  evidence: { ecccCommunityMatch?: boolean } = {},
): CanonicalJurisdiction {
  const resolved = resolveJurisdiction({
    latitude: query.latitude,
    longitude: query.longitude,
    at: query.evaluatedAt,
    countryHint: query.countryCode,
    subdivisionHint: query.subdivisionCode,
  });
  const communityMissing = resolved.requiresCommunityMatch && !evidence.ecccCommunityMatch;
  return {
    countryCode: resolved.countryCode,
    subdivisionCode: resolved.subdivisionCode,
    programId: communityMissing ? null : resolved.programId,
    resolution: resolved.resolution,
    resolverId: resolved.resolverId,
    resolverRevision: resolved.resolverRevision,
    requestHintMatched: resolved.requestHintMatched,
    localStandardId: communityMissing ? null : resolved.localStandardId,
  };
}
