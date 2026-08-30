import { createHash } from "node:crypto";

import {
  type AirQualityEvidence,
  type AirQualityStationFeature,
  type AirQualityStationsResponse,
  airQualityStationsResponseSchema,
  type Pollutant,
} from "@openmapx/air-quality";
import type { IntegrationContext, StationViewportQuery } from "@openmapx/integration-framework";

import { resolvePointJurisdiction } from "./jurisdiction.js";
import { normalizeProviderEvidence } from "./normalize.js";
import { createAirQualityOrchestrator } from "./orchestrator.js";
import { discoverAirQualityProviders } from "./providers.js";
import type { ParsedStationQuery } from "./query.js";
import {
  createStationSnapshot,
  encodeStationCursor,
  policyFingerprint,
  readStationSnapshot,
  type StationSnapshot,
} from "./station-snapshot.js";

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

function stationId(item: AirQualityEvidence): string {
  const digest = createHash("sha256")
    .update("openmapx-air-quality-station-v1\0")
    .update(item.providerId)
    .update("\0")
    .update(item.spatial.id)
    .digest("base64url");
  return `stn_1_${digest}`;
}

export function webMercatorCell(
  longitude: number,
  latitude: number,
  west: number,
  east: number,
  zoom: number,
): string {
  const gridZoom = Math.max(0, Math.min(26, Math.floor(zoom) + 4));
  const scale = 2 ** gridZoom;
  const unwrappedLongitude = west > east && longitude < west ? longitude + 360 : longitude;
  const unwrappedWestOffset = west > east && unwrappedLongitude > 180 ? 360 : 0;
  const x =
    Math.floor(((unwrappedLongitude + 180 - unwrappedWestOffset) / 360) * scale) +
    Math.floor(unwrappedWestOffset / 360) * scale;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = (clamped * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * scale);
  return `${gridZoom}/${x}/${y}`;
}

function evidenceTime(item: AirQualityEvidence): number {
  return Date.parse(item.observedAt ?? item.publishedAt ?? "") || 0;
}

function stationRank(item: AirQualityEvidence, priority: number): readonly (number | string)[] {
  return [
    item.freshness === "fresh" ? 0 : item.freshness === "stale" ? 1 : 2,
    item.spatial.stationClass === "reference"
      ? 0
      : item.spatial.stationClass === "regulatory"
        ? 1
        : item.spatial.stationClass === "indicative"
          ? 2
          : item.spatial.stationClass === "low-cost"
            ? 3
            : 4,
    item.spatial.mobile === true ? 1 : 0,
    item.basis === "ground" ? 0 : item.basis === "hybrid" ? 1 : 2,
    -evidenceTime(item),
    priority,
    item.observationId,
  ];
}

function compareTuple(
  left: readonly (number | string)[],
  right: readonly (number | string)[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b));
  }
  return 0;
}

function toFeature(
  item: AirQualityEvidence,
  pollutant: Pollutant,
): AirQualityStationFeature | null {
  const coordinates = item.spatial.coordinates;
  const summary = item.pollutants.find((candidate) => candidate.pollutant === pollutant);
  if (!coordinates || !summary || item.observedAt === null) return null;
  const localIndex = item.indices.find(({ standardId }) => standardId !== null) ?? null;
  const id = stationId(item);
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates },
    properties: {
      stationId: id,
      name: item.spatial.name,
      pollutant,
      value: summary.value,
      unit: summary.unit,
      intervalStart: summary.intervalStart,
      intervalEnd: summary.intervalEnd,
      freshness: item.freshness,
      observedAt: item.observedAt,
      stationClass: item.spatial.stationClass,
      mobile: item.spatial.mobile,
      owner: item.sources.find(({ owner }) => owner !== null)?.owner ?? null,
      providerId: item.providerId,
      sourceIds: item.sourceIds,
      localIndex:
        localIndex?.standardId === null || localIndex === null
          ? null
          : {
              indexId: localIndex.indexId,
              standardId: localIndex.standardId,
              value: localIndex.value,
              displayValue: localIndex.displayValue,
              categoryId: localIndex.categoryId,
            },
    },
  };
}

function pageResponse(
  ctx: IntegrationContext,
  input: {
    snapshotId: string;
    snapshot: StationSnapshot;
    offset: number;
    limit: number;
  },
): AirQualityStationsResponse {
  let features = input.snapshot.features.slice(input.offset, input.offset + input.limit);
  const build = (items: AirQualityStationFeature[]): AirQualityStationsResponse => {
    const actualNextOffset = input.offset + items.length;
    const hasMore = actualNextOffset < input.snapshot.features.length;
    return {
      type: "FeatureCollection",
      features: items,
      nextCursor: hasMore
        ? encodeStationCursor(ctx, {
            snapshotId: input.snapshotId,
            queryHash: input.snapshot.queryHash,
            offset: actualNextOffset,
          })
        : null,
      meta: {
        generatedAt: new Date().toISOString(),
        cache: input.offset === 0 ? "miss" : "fresh",
        providersCandidate: input.snapshot.diagnostics.providersCandidate,
        providersServed: input.snapshot.diagnostics.providersServed,
        providersFailed: input.snapshot.diagnostics
          .providersFailed as AirQualityStationsResponse["meta"]["providersFailed"],
        providersPolicyExcluded: input.snapshot.diagnostics.providersPolicyExcluded,
        truncated:
          input.snapshot.diagnostics.truncated ||
          items.length < Math.min(input.limit, input.snapshot.features.length - input.offset),
        warnings: input.snapshot.diagnostics.warnings,
        candidateCount: input.snapshot.diagnostics.candidateCount,
        servedCount: items.length,
        skippedCount: input.snapshot.diagnostics.skippedCount,
      },
    };
  };
  let response = build(features);
  while (features.length > 0 && Buffer.byteLength(JSON.stringify(response)) > MAX_RESPONSE_BYTES) {
    features = features.slice(0, -1);
    response = build(features);
  }
  return airQualityStationsResponseSchema.parse(response);
}

export function createStationsService(ctx: IntegrationContext) {
  const orchestrator = createAirQualityOrchestrator(ctx);

  return async function stations(
    query: ParsedStationQuery,
    signal?: AbortSignal,
  ): Promise<AirQualityStationsResponse> {
    const providerQuery: StationViewportQuery = {
      south: query.south,
      west: query.west,
      north: query.north,
      east: query.east,
      zoom: query.zoom,
      pollutant: query.pollutant,
      limit: 2_000,
    };
    const policyCandidates = discoverAirQualityProviders(ctx).filter(({ provider }) =>
      provider.capabilities.has("stations"),
    );
    const disallowed = (await ctx.getDisallowedSourceIds?.()) ?? new Set<string>();
    const policyExcluded = policyCandidates
      .filter(({ provider }) => provider.sourceIds.some((sourceId) => disallowed.has(sourceId)))
      .map(({ provider }) => provider.id)
      .sort();
    const fingerprint = policyFingerprint({
      candidates: policyCandidates.map(({ provider }) => provider.id),
      excluded: policyExcluded,
    });
    if (query.cursor) {
      const restored = await readStationSnapshot(ctx, query.cursor, query.queryHash, disallowed);
      return pageResponse(ctx, { ...restored, limit: query.limit });
    }

    const preflight = await orchestrator.preflight("stations");

    const orchestration = await orchestrator.stations(providerQuery, signal, preflight);
    const priorities = Object.fromEntries(
      orchestration.results.map(({ provider }) => [provider.id, provider.priority]),
    );
    const candidates: AirQualityEvidence[] = [];
    let invalidCount = 0;
    for (const result of orchestration.results) {
      for (const raw of result.page.evidence) {
        const coordinates = raw.spatial.coordinates;
        if (!coordinates) {
          invalidCount += 1;
          continue;
        }
        const jurisdiction = resolvePointJurisdiction({
          latitude: coordinates[1],
          longitude: coordinates[0],
          evaluatedAt: raw.observedAt ?? new Date().toISOString(),
        });
        try {
          candidates.push(
            normalizeProviderEvidence(raw, {
              targetAt: raw.observedAt ?? new Date().toISOString(),
              mode: "current",
              localStandardId: jurisdiction.localStandardId,
              comparisonStandardId: null,
              subdivisionCode: jurisdiction.subdivisionCode,
            }).evidence,
          );
        } catch {
          invalidCount += 1;
        }
      }
    }
    const cells = new Map<string, AirQualityEvidence>();
    for (const item of candidates) {
      const coordinates = item.spatial.coordinates;
      if (!coordinates || !item.pollutants.some(({ pollutant }) => pollutant === query.pollutant))
        continue;
      const cell = webMercatorCell(
        coordinates[0],
        coordinates[1],
        query.west,
        query.east,
        query.zoom,
      );
      const prior = cells.get(cell);
      if (
        !prior ||
        compareTuple(
          stationRank(item, priorities[item.providerId] ?? Number.MAX_SAFE_INTEGER),
          stationRank(prior, priorities[prior.providerId] ?? Number.MAX_SAFE_INTEGER),
        ) < 0
      )
        cells.set(cell, item);
    }
    const features = [...cells.values()]
      .map((item) => toFeature(item, query.pollutant))
      .filter((feature): feature is AirQualityStationFeature => feature !== null)
      .sort((left, right) => left.id.localeCompare(right.id));
    const warnings = new Set<AirQualityStationsResponse["meta"]["warnings"][number]>();
    if (orchestration.diagnostics.providersFailed.length > 0) warnings.add("partial_providers");
    if (orchestration.diagnostics.providersPolicyExcluded.length > 0)
      warnings.add("policy_excluded");
    if (orchestration.diagnostics.truncated || features.length > 2_000)
      warnings.add("quota_truncated");
    const created = await createStationSnapshot(ctx, {
      queryHash: query.queryHash,
      policyFingerprint: fingerprint,
      features,
      diagnostics: {
        providersCandidate: orchestration.diagnostics.providersCandidate,
        providersServed: orchestration.diagnostics.providersServed,
        providersFailed: orchestration.diagnostics.providersFailed,
        providersPolicyExcluded: orchestration.diagnostics.providersPolicyExcluded,
        truncated: orchestration.diagnostics.truncated,
        warnings: [...warnings].sort(),
        candidateCount: orchestration.results.reduce(
          (sum, { page }) => sum + page.diagnostics.candidateCount,
          0,
        ),
        skippedCount:
          invalidCount +
          orchestration.results.reduce((sum, { page }) => sum + page.diagnostics.skippedCount, 0) +
          Math.max(0, candidates.length - features.length),
      },
    });
    return pageResponse(ctx, {
      snapshotId: created.snapshotId,
      snapshot: created.snapshot,
      offset: 0,
      limit: query.limit,
    });
  };
}
