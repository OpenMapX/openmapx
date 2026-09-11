import {
  COVERAGE_OPERATION_IDS,
  type CoverageDomain,
  type CoverageDomainOperationId,
  type CoveragePermission,
  type RightsEvidence,
} from "@openmapx/core/coverage";
import type {
  GeocodingProvider,
  IntegrationDataSource,
  LoadedIntegration,
  MobilityDataSourceProvider,
  PoiSearchProvider,
  RealtimeProvider,
  RoadConditionsProvider,
  RoutingProvider,
  TransitProvider,
} from "@openmapx/integration-framework";

export interface CoverageProviderDescriptor {
  candidateId: string;
  integrationId: string;
  providerId: string;
  label: string;
  kind:
    | "geocoding"
    | "poi-search"
    | "transit"
    | "realtime"
    | "data-source"
    | "routing"
    | "road-conditions";
  enabled: boolean;
  sourceIds: string[];
  provider: unknown;
  supports: Partial<Record<CoverageDomainOperationId, boolean>>;
}

export interface CoverageCatalog {
  integrations: readonly LoadedIntegration[];
  providers: CoverageProviderDescriptor[];
  rights: RightsEvidence[];
}

export const COVERAGE_OPERATION_LABELS: Record<CoverageDomainOperationId, string> = {
  "addresses.forward-search": "Forward address search",
  "addresses.reverse-geocoding": "Reverse geocoding",
  "pois.search": "POI search",
  "pois.overture-enrichment": "POI enrichment",
  "transit.stop-search": "Transit stop search",
  "transit.departures": "Transit departures",
  "transit.journey-planning": "Transit journey planning",
  "transit.realtime": "Transit realtime",
  "ev.charger-discovery": "Charger discovery",
  "ev.charger-availability": "Live charger availability",
  "ev.route-planning": "EV route planning",
  "parking.facility-discovery": "Parking facility discovery",
  "parking.occupancy": "Live parking occupancy",
  "traffic.flow": "Traffic flow",
  "traffic.road-conditions": "Road conditions",
  "traffic.traffic-aware-routing": "Traffic-aware routing",
};

export const OPERATION_DEFINITIONS: ReadonlyArray<{
  id: CoverageDomainOperationId;
  domain: CoverageDomain;
}> = [
  { id: "addresses.forward-search", domain: "addresses" },
  { id: "addresses.reverse-geocoding", domain: "addresses" },
  { id: "pois.search", domain: "pois" },
  { id: "pois.overture-enrichment", domain: "pois" },
  { id: "transit.stop-search", domain: "transit" },
  { id: "transit.departures", domain: "transit" },
  { id: "transit.journey-planning", domain: "transit" },
  { id: "transit.realtime", domain: "transit" },
  { id: "ev.charger-discovery", domain: "ev" },
  { id: "ev.charger-availability", domain: "ev" },
  { id: "ev.route-planning", domain: "ev" },
  { id: "parking.facility-discovery", domain: "parking" },
  { id: "parking.occupancy", domain: "parking" },
  { id: "traffic.flow", domain: "traffic" },
  { id: "traffic.road-conditions", domain: "traffic" },
  { id: "traffic.traffic-aware-routing", domain: "traffic" },
];

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : fallback;
}

function permission(value: unknown): CoveragePermission {
  return value === "yes" || value === "no" || value === "conditional" || value === "unknown"
    ? value
    : "unknown";
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    const credentialParameterNames = new Set([
      "access_token",
      "api_key",
      "apikey",
      "client_secret",
      "credential",
      "key",
      "password",
      "secret",
      "sig",
      "signature",
      "token",
    ]);
    for (const name of url.searchParams.keys()) {
      if (credentialParameterNames.has(name.toLocaleLowerCase())) return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function sourceIdsFor(integration: LoadedIntegration, provider: unknown): string[] {
  const declared = new Set(
    (integration.manifest.dataSources ?? []).map((source) => source.sourceId),
  );
  const attributions = provider as { attribution?: unknown };
  if (Array.isArray(attributions.attribution)) {
    const ids = attributions.attribution
      .map((entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { sourceId?: unknown }).sourceId === "string"
          ? (entry as { sourceId: string }).sourceId
          : null,
      )
      .filter((id): id is string => id !== null);
    if (ids.length > 0) return [...new Set(ids)].sort();
  }
  return [...declared].sort();
}

function supports(
  integrationId: string,
  providerId: string,
  operationIds: readonly CoverageDomainOperationId[],
  operationSupported: (operationId: CoverageDomainOperationId) => boolean,
  provider: unknown,
  kind: CoverageProviderDescriptor["kind"],
  integration: LoadedIntegration,
): CoverageProviderDescriptor {
  return {
    candidateId: `${integrationId}:${kind}:${providerId}`.slice(0, 512),
    integrationId,
    providerId,
    label: text((provider as { id?: unknown }).id, providerId),
    kind,
    enabled: integration.enabled,
    sourceIds: sourceIdsFor(integration, provider),
    provider,
    supports: Object.fromEntries(
      operationIds.map((operationId) => [operationId, operationSupported(operationId)]),
    ),
  };
}

function providerId(provider: unknown, integration: LoadedIntegration, index: number): string {
  return text((provider as { id?: unknown }).id, `${integration.id}-${index}`);
}

function asProviders(integration: LoadedIntegration, kind: string): unknown[] {
  return integration.providers.get(kind) ?? [];
}

function makeProviders(integration: LoadedIntegration): CoverageProviderDescriptor[] {
  const result: CoverageProviderDescriptor[] = [];
  const geocodingIds = COVERAGE_OPERATION_IDS.filter((id) => id.startsWith("addresses."));
  for (const [index, raw] of asProviders(integration, "geocoding").entries()) {
    const provider = raw as GeocodingProvider;
    const id = providerId(provider, integration, index);
    result.push(
      supports(
        integration.id,
        id,
        geocodingIds,
        (operationId) =>
          operationId === "addresses.forward-search"
            ? typeof provider.geocode === "function" || typeof provider.autocomplete === "function"
            : typeof provider.reverseGeocode === "function",
        provider,
        "geocoding",
        integration,
      ),
    );
  }

  const poiIds = COVERAGE_OPERATION_IDS.filter((id) => id.startsWith("pois."));
  for (const [index, raw] of asProviders(integration, "poi-search").entries()) {
    const provider = raw as PoiSearchProvider;
    const id = providerId(provider, integration, index);
    result.push(
      supports(
        integration.id,
        id,
        poiIds,
        (operationId) =>
          operationId === "pois.overture-enrichment"
            ? integration.id === "poi-overture" &&
              id === "overture" &&
              typeof provider.getDetail === "function"
            : typeof provider.search === "function",
        provider,
        "poi-search",
        integration,
      ),
    );
  }

  const transitIds = COVERAGE_OPERATION_IDS.filter((id) =>
    ["transit.stop-search", "transit.departures", "transit.journey-planning"].includes(id),
  );
  for (const [index, raw] of asProviders(integration, "transit").entries()) {
    const provider = raw as TransitProvider;
    const capabilities = provider.capabilities;
    const id = providerId(provider, integration, index);
    result.push(
      supports(
        integration.id,
        id,
        transitIds,
        (operationId) => {
          if (operationId === "transit.stop-search") {
            return (
              capabilities?.stops.search === true &&
              typeof provider.searchStopsByName === "function"
            );
          }
          if (operationId === "transit.departures") {
            return (
              capabilities?.departures === true && typeof provider.getDepartures === "function"
            );
          }
          return capabilities?.planning === true && typeof provider.planTrip === "function";
        },
        provider,
        "transit",
        integration,
      ),
    );
  }

  for (const [index, raw] of asProviders(integration, "live-transit").entries()) {
    const provider = raw as RealtimeProvider;
    const id = providerId(provider, integration, index);
    result.push(
      supports(
        integration.id,
        id,
        ["transit.realtime"],
        () =>
          Boolean(
            (provider.capabilities?.vehiclePositions && provider.getVehiclePositions) ||
              (provider.capabilities?.alerts?.byBbox && provider.getAlertsForBbox) ||
              (provider.capabilities?.tripUpdates &&
                (provider.getTripUpdate || provider.getTripUpdates)),
          ),
        provider,
        "realtime",
        integration,
      ),
    );
  }

  for (const [index, raw] of asProviders(integration, "data-source").entries()) {
    const provider = raw as MobilityDataSourceProvider;
    const id = providerId(provider, integration, index);
    const dataDomain =
      integration.id === "ev-charging" ? "ev" : integration.id === "parking" ? "parking" : null;
    if (!dataDomain) continue;
    const ids = COVERAGE_OPERATION_IDS.filter((operationId) =>
      dataDomain === "ev" ? operationId.startsWith("ev.") : operationId.startsWith("parking."),
    );
    result.push(
      supports(
        integration.id,
        id,
        ids,
        (operationId) =>
          operationId.endsWith("discovery") || operationId.endsWith("facility-discovery")
            ? typeof provider.search === "function"
            : Boolean(provider.searchStations || provider.search),
        provider,
        "data-source",
        integration,
      ),
    );
  }

  const routingIds = COVERAGE_OPERATION_IDS.filter(
    (id) => id === "ev.route-planning" || id === "traffic.traffic-aware-routing",
  );
  for (const [index, raw] of asProviders(integration, "routing").entries()) {
    const provider = raw as RoutingProvider;
    const id = providerId(provider, integration, index);
    result.push(
      supports(
        integration.id,
        id,
        routingIds,
        (operationId) =>
          operationId === "traffic.traffic-aware-routing"
            ? integration.id === "routing-valhalla" && id === "valhalla"
            : (provider.supportedModes ?? []).includes("driving"),
        provider,
        "routing",
        integration,
      ),
    );
  }

  const roadIds = COVERAGE_OPERATION_IDS.filter((id) =>
    ["traffic.flow", "traffic.road-conditions"].includes(id),
  );
  for (const [index, raw] of asProviders(integration, "road-conditions").entries()) {
    const provider = raw as RoadConditionsProvider;
    const id = providerId(provider, integration, index);
    result.push(
      supports(
        integration.id,
        id,
        roadIds,
        (operationId) =>
          operationId === "traffic.flow"
            ? typeof provider.getFlow === "function"
            : typeof provider.getEvents === "function",
        provider,
        "road-conditions",
        integration,
      ),
    );
  }
  return result;
}

export function buildCoverageCatalog(integrations: readonly LoadedIntegration[]): CoverageCatalog {
  const rights: RightsEvidence[] = [];
  const occurrences = new Map<string, number>();
  for (const integration of integrations) {
    for (const source of integration.manifest.dataSources ?? []) {
      const record = rightsForSource(integration, source);
      const occurrence = occurrences.get(record.key) ?? 0;
      occurrences.set(record.key, occurrence + 1);
      rights.push(
        occurrence === 0
          ? record
          : {
              ...record,
              // Keep duplicate assertions visible so a conflict is not hidden
              // by a winner-takes-all Map join. The qualified dataset key
              // remains unchanged and is what groups assertions.
              key: `${record.key}:assertion-${occurrence}`.slice(0, 512),
            },
      );
    }
  }
  const assertionsByDataset = new Map<string, RightsEvidence[]>();
  for (const record of rights) {
    const group = assertionsByDataset.get(record.qualifiedDatasetKey) ?? [];
    group.push(record);
    assertionsByDataset.set(record.qualifiedDatasetKey, group);
  }
  for (const group of assertionsByDataset.values()) {
    const signatures = new Set(group.map(rightsAssertionSignature));
    if (signatures.size < 2) continue;
    for (const record of group) record.conflict = true;
  }
  return {
    integrations,
    providers: integrations
      .flatMap(makeProviders)
      .sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    rights: rights.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function rightsAssertionSignature(record: RightsEvidence): string {
  return JSON.stringify({
    commercialUse: record.commercialUse,
    redistribution: record.redistribution,
    license: record.license ?? null,
    licenseUrl: record.licenseUrl ?? null,
    termsUrl: record.termsUrl ?? null,
    attribution: record.attribution ?? null,
    usageConditions: record.usageConditions,
  });
}

export function rightsForSource(
  integration: Pick<LoadedIntegration, "id" | "manifest">,
  source: IntegrationDataSource,
): RightsEvidence {
  const key = `rights:${integration.id}:${source.sourceId}`.slice(0, 512);
  return {
    key,
    qualifiedDatasetKey: `${integration.id}:${source.sourceId}`.slice(0, 512),
    owner: { kind: "integration", id: integration.id },
    sourceId: source.sourceId,
    name: source.name.slice(0, 256),
    commercialUse: permission(source.commercialUse),
    redistribution: {
      sourceData: permission(source.redistribution?.sourceData),
      derivedData: permission(source.redistribution?.derivedData),
    },
    license: source.license.slice(0, 512),
    ...(safeUrl(source.licenseUrl) ? { licenseUrl: safeUrl(source.licenseUrl) } : {}),
    ...(safeUrl(source.termsUrl) ? { termsUrl: safeUrl(source.termsUrl) } : {}),
    ...(typeof source.attribution === "string"
      ? { attribution: source.attribution.slice(0, 1_000) }
      : {}),
    usageConditions: (source.usageConditions ?? []).map((condition) => condition.slice(0, 1_000)),
    ...(source.reviewedAt ? { reviewedAt: source.reviewedAt } : {}),
    evidenceOrigin: "loaded integration manifest",
    lineageKnown: true,
  };
}
