import {
  type AuthorityObservation,
  type CoverageReasonCode,
  evaluateFreshness,
  isCountryRegionKey,
  type RightsEvidence,
  type RuntimeStatus,
  type StreamEvidence,
} from "@openmapx/core/coverage";
import { services } from "@openmapx/core/server";
import type {
  ChargingSiteProvider,
  LoadedIntegration,
  OperationalEvidence,
  ProviderHealthSnapshot,
  RoadConditionsProvider,
} from "@openmapx/integration-framework";
import { getAllIntegrations } from "../../integration-host.js";
import { loadAllBindingsByIntegration } from "../capability-bindings.js";
import { type DataUsePolicy, getDataUsePolicy } from "../data-use-policy.js";
import {
  getCachedIntegrationHealthSnapshot,
  type IntegrationHealthSnapshot,
} from "../integration-health.js";
import { getProviderHealth, type ProviderHealthPeek } from "../provider-health/registry.js";
import { getServiceRegistry } from "../service-registry.js";
import {
  createDataManagerEvidenceReader,
  type DataManagerEvidenceReader,
  type DataManagerEvidenceSnapshot,
} from "./adapters.js";
import {
  buildCoverageCatalog,
  type CoverageCatalog,
  type CoverageProviderDescriptor,
  PLACE_DOMAINS,
} from "./catalog.js";
import { roadConditionStreams } from "./road-conditions.js";
import { siteStreams } from "./sites.js";

const RUNTIME_MAX_AGE_MS = 120_000;
const PASSIVE_HEALTH_MAX_AGE_MS = 300_000;

export interface CoverageCollection {
  generatedAt: string;
  collectionStatus: "complete" | "partial" | "unavailable";
  authorities: AuthorityObservation[];
  warnings: CoverageReasonCode[];
  regions: DataManagerEvidenceSnapshot["regions"];
  streams: StreamEvidence[];
  catalog: CoverageCatalog;
  integrationHealth: IntegrationHealthSnapshot;
  providerHealth: Map<string, ProviderHealthPeek>;
  bindings: Map<string, Map<string, string>>;
  requirementStates?: Map<string, "resolved" | "missing" | "unknown" | "not-required">;
  policy: DataUsePolicy | null;
  unassignedSourceCount: number;
  dataManagerSnapshotId: string;
}

export interface CoverageCollectorOptions {
  now?: () => Date;
  integrations?: readonly LoadedIntegration[];
  dataManager?: DataManagerEvidenceReader;
  loadBindings?: () => Promise<Map<string, Map<string, string>>>;
  loadPolicy?: () => Promise<DataUsePolicy>;
  providerHealth?: ReturnType<typeof getProviderHealth>;
  integrationHealth?: (integrations: LoadedIntegration[]) => IntegrationHealthSnapshot;
}

export class CoverageCollectionUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CoverageCollectionUnavailableError";
  }
}

function uniqueReasons(values: readonly CoverageReasonCode[]): CoverageReasonCode[] {
  return [...new Set(values)];
}

function nowIso(now: Date): string {
  return now.toISOString();
}

/**
 * The coverage domain of an integration's source: from the manifest domain
 * the source names, else from the integration's domains.
 */
function domainForIntegration(
  integration: LoadedIntegration,
  source: { domain?: string } = {},
): CoverageCollection["streams"][number]["domain"] | null {
  const domains = source.domain !== undefined ? [source.domain] : integration.manifest.domains;
  if (domains.includes("geocoding")) return "addresses";
  if (domains.includes("poi-search")) return "pois";
  if (domains.includes("transit") || domains.includes("live-transit")) return "transit";
  if (domains.includes("road-conditions")) return "traffic";
  return PLACE_DOMAINS.find((place) => domains.includes(place.kind))?.domain ?? null;
}

/** A provider's operational evidence and how it becomes coverage streams. */
interface OperationalRead {
  read(): Promise<OperationalEvidence>;
  streams(snapshot: OperationalEvidence): StreamEvidence[];
}

/**
 * The operational evidence the enabled providers publish: road conditions
 * from the road-conditions providers, places from the charging, parking, fuel
 * and camera providers. At most 32 reads.
 */
function operationalReads(
  catalog: CoverageCatalog,
  integrations: readonly LoadedIntegration[],
): OperationalRead[] {
  const roads = catalog.providers
    .filter(
      (p) =>
        p.kind === "road-conditions" &&
        p.enabled &&
        (p.provider as RoadConditionsProvider).getOperationalEvidence,
    )
    .map(
      (p): OperationalRead => ({
        read: () => (p.provider as RoadConditionsProvider).getOperationalEvidence!(),
        streams: (snapshot) => roadConditionStreams(p.integrationId, snapshot),
      }),
    );
  const places = integrations
    .filter((integration) => integration.enabled)
    .flatMap((integration) =>
      PLACE_DOMAINS.flatMap(({ kind, domain }) =>
        (integration.providers.get(kind) ?? [])
          .map((raw) => raw as Pick<ChargingSiteProvider, "getOperationalEvidence">)
          .filter((provider) => typeof provider.getOperationalEvidence === "function")
          .map(
            (provider): OperationalRead => ({
              read: () => provider.getOperationalEvidence!(),
              streams: (snapshot) => siteStreams(integration.id, domain, snapshot),
            }),
          ),
      ),
    );
  return [...roads, ...places].slice(0, 32);
}

function catalogStream(
  integration: LoadedIntegration,
  sourceId: string,
  name: string,
  domain: NonNullable<ReturnType<typeof domainForIntegration>>,
  at: string,
): StreamEvidence {
  const enabled = integration.enabled;
  return {
    key: `catalog:${integration.id}:${sourceId}:declared`.slice(0, 512),
    owner: { kind: "integration", id: integration.id },
    sourceId,
    stream: "catalog",
    domain,
    observedAt: at,
    evidenceVersion: 1,
    presence: enabled ? "unknown" : "not-configured",
    region: { keys: [], basis: "unknown", relation: "unknown", label: name.slice(0, 256) },
    publication: { version: null, publishedAt: null, active: enabled ? null : false },
    attempt: { at: null, outcome: "unknown" },
    lastSuccessfulCheckAt: null,
    lastSuccessfullyCheckedVersion: null,
    upstreamAsOf: null,
    expiresAt: null,
    policy: {
      basis: "catalog-only",
      staleAt: null,
      expiresAt: null,
      version: "coverage-v1",
      provenance: "manifest declaration without a publication adapter",
    },
    freshness: enabled ? "unknown" : "not-applicable",
    reasons: enabled ? ["no_publication_evidence", "region_unknown"] : ["not_configured"],
  };
}

function addCatalogStreams(
  integrations: readonly LoadedIntegration[],
  streams: readonly StreamEvidence[],
  at: string,
): StreamEvidence[] {
  const existing = new Set(
    streams.map((stream) => `${stream.owner.kind}:${stream.owner.id}:${stream.sourceId}`),
  );
  const output = [...streams];
  for (const integration of integrations) {
    for (const source of integration.manifest.dataSources ?? []) {
      const domain = domainForIntegration(integration, source);
      if (!domain) continue;
      const identity = `integration:${integration.id}:${source.sourceId}`;
      if (existing.has(identity)) continue;
      output.push(catalogStream(integration, source.sourceId, source.name, domain, at));
      existing.add(identity);
    }
  }
  return output.sort((a, b) => a.key.localeCompare(b.key));
}

function safeProviderIds(catalog: CoverageCatalog): string[] {
  return [
    ...new Set(catalog.providers.map((provider) => provider.providerId).filter(Boolean)),
  ].slice(0, 500);
}

function authority(
  name: AuthorityObservation["authority"],
  status: AuthorityObservation["status"],
  at: string,
  message?: string,
): AuthorityObservation {
  return {
    authority: name,
    status,
    observedAt: at,
    ...(message ? { message: message.slice(0, 500) } : {}),
  };
}

function mergeAuthorities(
  current: AuthorityObservation[],
  next: readonly AuthorityObservation[],
): AuthorityObservation[] {
  const severity = { available: 1, partial: 2, unavailable: 3 } as const;
  const byAuthority = new Map<AuthorityObservation["authority"], AuthorityObservation>();
  for (const item of [...current, ...next]) {
    const existing = byAuthority.get(item.authority);
    if (!existing || severity[item.status] >= severity[existing.status]) {
      byAuthority.set(item.authority, item);
    }
  }
  return [...byAuthority.values()].sort((a, b) => a.authority.localeCompare(b.authority));
}

function providerHealthStatus(
  provider: CoverageProviderDescriptor,
  observations: Map<string, ProviderHealthPeek>,
  scheduled: IntegrationHealthSnapshot,
  integration: LoadedIntegration,
  at: number,
): {
  status: RuntimeStatus;
  reason?: CoverageReasonCode;
  observedAt: string | null;
  snapshot?: ProviderHealthSnapshot;
  maxAgeMs?: number;
  origin?: "scheduled" | "passive";
} {
  if (!integration.enabled)
    return { status: "unconfigured", reason: "not_configured", observedAt: null };
  const scheduledResult = scheduled.results.find((result) => result.id === integration.id);
  const scheduledAt = scheduled.updatedAt;
  const scheduledFresh =
    scheduledAt !== null &&
    Number.isFinite(scheduledAt) &&
    scheduledAt <= at &&
    at - scheduledAt < RUNTIME_MAX_AGE_MS;
  const scheduledStatus: RuntimeStatus =
    scheduledFresh && scheduledResult
      ? scheduledResult.status === "up"
        ? "up"
        : scheduledResult.status === "unconfigured"
          ? "unconfigured"
          : "down"
      : "unknown";
  const fallback = {
    status: scheduledStatus,
    reason:
      scheduledStatus === "unknown"
        ? ("health_unobserved" as const)
        : scheduledStatus === "down"
          ? ("runtime_down" as const)
          : undefined,
    observedAt: scheduledFresh && scheduledAt !== null ? new Date(scheduledAt).toISOString() : null,
    maxAgeMs: RUNTIME_MAX_AGE_MS,
    origin: "scheduled" as const,
  };
  const passive = observations.get(provider.providerId);
  if (!passive || passive.status === "unobserved") return fallback;
  if (passive.status !== "observed" || !passive.snapshot) return fallback;
  const snapshot = passive.snapshot;
  if (snapshot.state === "open") {
    return {
      status: "down",
      reason: "runtime_down",
      observedAt: snapshot.lastFailureAt,
      snapshot,
      maxAgeMs: PASSIVE_HEALTH_MAX_AGE_MS,
      origin: "passive",
    };
  }
  // A current scheduled failure must not be rescued by a circuit's earlier success.
  if (scheduledStatus === "down" || scheduledStatus === "unconfigured") return fallback;
  const lastSuccessAt = snapshot.lastSuccessAt ? Date.parse(snapshot.lastSuccessAt) : NaN;
  if (
    !Number.isFinite(lastSuccessAt) ||
    lastSuccessAt > at ||
    at - lastSuccessAt >= PASSIVE_HEALTH_MAX_AGE_MS
  )
    return fallback;
  const degraded = snapshot.state === "degraded" || snapshot.state === "half-open";
  return {
    status: degraded ? "degraded" : "up",
    reason: degraded ? "runtime_degraded" : undefined,
    observedAt: snapshot.lastSuccessAt,
    snapshot,
    maxAgeMs: PASSIVE_HEALTH_MAX_AGE_MS,
    origin: "passive",
  };
}

export function runtimeForProvider(
  provider: CoverageProviderDescriptor,
  collection: Pick<CoverageCollection, "integrationHealth" | "providerHealth" | "catalog">,
  now: Date,
): ReturnType<typeof providerHealthStatus> {
  const integration = collection.catalog.integrations.find(
    (item) => item.id === provider.integrationId,
  );
  if (!integration) {
    return { status: "unknown", reason: "lineage_unknown", observedAt: null };
  }
  return providerHealthStatus(
    provider,
    collection.providerHealth,
    collection.integrationHealth,
    integration,
    now.getTime(),
  );
}

/**
 * Whether a stream names no place at all: no region and no area. A stream
 * with a declared area (a global source's world box) is placed by it.
 */
export function isUnassigned(stream: StreamEvidence): boolean {
  return stream.region.keys.length === 0 && stream.region.bounds === undefined;
}

const countryNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "code" });

/** A country region's English name, e.g. "Germany" for `country:DE`; the code when unknown. */
function countryLabel(key: string): string {
  const code = key.slice("country:".length).toUpperCase();
  try {
    return countryNames.of(code) ?? code;
  } catch {
    return code;
  }
}

async function boundedRead<T>(read: () => Promise<T>, timeoutMs = 3500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Authority read timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function collectCoverageData(
  options: CoverageCollectorOptions = {},
): Promise<CoverageCollection> {
  const now = options.now?.() ?? new Date();
  const generatedAt = nowIso(now);
  const integrations = (options.integrations ?? getAllIntegrations()).map((integration) => ({
    ...integration,
    manifest: structuredClone(integration.manifest),
  }));
  const catalog = buildCoverageCatalog(integrations);
  const operational = operationalReads(catalog, integrations);
  const dataManager = options.dataManager ?? createDataManagerEvidenceReader();
  // Start independent authorities together. A stuck store must neither delay
  // healthy evidence nor extend the API's five-second response budget.
  const [reads, operationalResults] = await Promise.all([
    Promise.allSettled([
      boundedRead(() => dataManager.read()),
      boundedRead(options.loadBindings ?? loadAllBindingsByIntegration),
      boundedRead(options.loadPolicy ?? getDataUsePolicy),
      boundedRead(async () => {
        const health =
          options.providerHealth === undefined ? getProviderHealth() : options.providerHealth;
        return health ? health.peekMany(safeProviderIds(catalog)) : null;
      }),
    ]),
    // Each provider's read has its own bound: a slow one costs only its own streams.
    Promise.allSettled(
      operational.map(async (entry) => ({ entry, snapshot: await boundedRead(entry.read) })),
    ),
  ]);
  let data: DataManagerEvidenceSnapshot;
  try {
    if (reads[0].status === "rejected") throw reads[0].reason;
    data = reads[0].value;
  } catch {
    data = {
      snapshotId: "unavailable",
      generatedAt,
      evaluatedAt: generatedAt,
      collectionStatus: "partial",
      authorities: [authority("data-manager", "unavailable", generatedAt)],
      warnings: ["data_manager_unavailable"],
      regions: [],
      evidence: [],
      rights: [],
      total: 0,
      retainedTotal: 0,
      truncated: false,
      unassignedSourceCount: 0,
    };
  }

  const warnings: CoverageReasonCode[] = [...data.warnings];
  let collectionStatus: CoverageCollection["collectionStatus"] = data.collectionStatus;
  const authorities = [...data.authorities];
  let bindings = new Map<string, Map<string, string>>();
  try {
    if (reads[1].status === "rejected") throw reads[1].reason;
    bindings = reads[1].value;
  } catch {
    collectionStatus = "partial";
    warnings.push("collector_unavailable", "binding_missing");
    authorities.push(authority("postgres", "partial", generatedAt, "Authority read failed"));
  }

  let policy: DataUsePolicy | null = null;
  try {
    if (reads[2].status === "rejected") throw reads[2].reason;
    policy = reads[2].value;
  } catch {
    collectionStatus = "partial";
    warnings.push("rights_unknown");
    authorities.push(authority("postgres", "partial", generatedAt, "Authority read failed"));
  }

  const integrationHealth =
    options.integrationHealth?.([...integrations]) ??
    getCachedIntegrationHealthSnapshot([...integrations]);
  if (
    integrations.some((integration) => integration.enabled && integration.manifest.healthCheck) &&
    integrationHealth.updatedAt === null
  ) {
    collectionStatus = "partial";
    warnings.push("health_unobserved");
  }
  authorities.push(
    authority(
      "integration-health",
      integrationHealth.updatedAt === null ? "partial" : "available",
      integrationHealth.updatedAt
        ? new Date(integrationHealth.updatedAt).toISOString()
        : generatedAt,
    ),
  );

  const providerIds = safeProviderIds(catalog);
  if (new Set(catalog.providers.map((provider) => provider.providerId)).size > 500) {
    warnings.push("evidence_truncated");
    collectionStatus = "partial";
  }
  const providerHealth = new Map<string, ProviderHealthPeek>();
  const healthRead = reads[3];
  if (healthRead.status === "fulfilled" && healthRead.value === null) {
    collectionStatus = "partial";
    for (const providerId of providerIds)
      providerHealth.set(providerId, { providerId, status: "unobserved" });
    authorities.push(
      authority("provider-health", "partial", generatedAt, "provider health is not initialized"),
    );
    warnings.push("health_unobserved");
  } else {
    try {
      if (healthRead.status === "rejected") throw healthRead.reason;
      for (const [id, observation] of healthRead.value ?? []) providerHealth.set(id, observation);
      const unavailable = [...providerHealth.values()].some(
        (value) => value.status === "store-unavailable" || value.status === "invalid-record",
      );
      if (unavailable) {
        collectionStatus = "partial";
        warnings.push("health_unobserved");
      }
      authorities.push(
        authority("provider-health", unavailable ? "partial" : "available", generatedAt),
      );
    } catch {
      for (const providerId of providerIds)
        providerHealth.set(providerId, { providerId, status: "store-unavailable" });
      collectionStatus = "partial";
      authorities.push(
        authority("provider-health", "unavailable", generatedAt, "Authority read failed"),
      );
      warnings.push("collector_unavailable", "health_unobserved");
    }
  }

  const operationalStreams: StreamEvidence[] = [];
  for (const read of operationalResults) {
    try {
      if (read.status === "rejected") throw read.reason;
      operationalStreams.push(...read.value.entry.streams(read.value.snapshot));
      if (read.value.snapshot.truncated) {
        collectionStatus = "partial";
        warnings.push("evidence_truncated");
      }
    } catch {
      collectionStatus = "partial";
      warnings.push("collector_unavailable");
    }
  }
  // A source with operational evidence is not listed again as a bare declaration.
  const streams = addCatalogStreams(
    integrations,
    [...data.evidence, ...operationalStreams],
    generatedAt,
  );

  const catalogWithServiceRights: CoverageCatalog = {
    ...catalog,
    rights: [...catalog.rights, ...(data.rights ?? [])].sort((a, b) => a.key.localeCompare(b.key)),
  };
  const requirementStates: NonNullable<CoverageCollection["requirementStates"]> = new Map();
  for (const integration of integrations) {
    const requirements = (integration.manifest.requires ?? []).filter((req) => !req.optional);
    if (requirements.length === 0) {
      requirementStates.set(integration.id, "not-required");
      continue;
    }
    try {
      const loaded = getServiceRegistry().list();
      const resolved = requirements.every(
        (req) =>
          services.resolveRequirement(loaded, req, { bindings: bindings.get(integration.id) })
            .satisfied,
      );
      requirementStates.set(
        integration.id,
        warnings.includes("binding_missing") ? "unknown" : resolved ? "resolved" : "missing",
      );
    } catch {
      requirementStates.set(integration.id, "unknown");
    }
  }
  const regions = data.regions.map((region) =>
    region.kind === "country" ? { ...region, label: countryLabel(region.key) } : region,
  );
  // Operational evidence names the countries its records are in; each is a region to report on.
  const known = new Set(regions.map((region) => region.key));
  for (const key of new Set(streams.flatMap((stream) => stream.region.keys))) {
    if (known.has(key) || !isCountryRegionKey(key)) continue;
    regions.push({ key, label: countryLabel(key), kind: "country" });
    known.add(key);
  }
  // The data manager lists its regions by key; the countries added here join that order.
  regions.sort((a, b) => a.key.localeCompare(b.key));
  if (streams.some(isUnassigned) && !regions.some((region) => region.key === "unassigned")) {
    regions.push({ key: "unassigned", label: "Region not specified", kind: "unassigned" });
  }
  const unassignedSourceCount = streams.filter(isUnassigned).length;
  if (collectionStatus === "unavailable") warnings.push("collector_unavailable");
  return {
    generatedAt,
    collectionStatus,
    authorities: mergeAuthorities(authorities, []),
    warnings: uniqueReasons(warnings),
    regions,
    streams,
    catalog: catalogWithServiceRights,
    integrationHealth,
    providerHealth,
    bindings,
    requirementStates,
    policy,
    unassignedSourceCount,
    dataManagerSnapshotId: data.snapshotId,
  };
}

export function freshenStream(stream: StreamEvidence, now: Date): StreamEvidence {
  const evaluation = evaluateFreshness({
    now: now.getTime(),
    presence: stream.presence,
    activeVersion: stream.publication.version,
    lastSuccessfulCheckAt: stream.lastSuccessfulCheckAt,
    lastSuccessfullyCheckedVersion: stream.lastSuccessfullyCheckedVersion,
    upstreamAsOf: stream.upstreamAsOf,
    expiresAt: stream.expiresAt,
    policy: stream.policy,
  });
  return {
    ...stream,
    freshness: evaluation.status,
    publication:
      evaluation.status === "expired"
        ? { ...stream.publication, active: false }
        : stream.publication,
    // Collection reasons describe the evidence observation itself (for
    // example a partially applied graph or an old active publication). Keep
    // them when freshness is recomputed at response time; the evaluation
    // contributes the additional deadline-dependent reasons.
    reasons: uniqueReasons([...stream.reasons, ...evaluation.reasons]),
  };
}

export function freshnessUsable(stream: StreamEvidence): boolean {
  if (stream.freshness === "current") return true;
  if (stream.freshness === "stale") return !isLiveStream(stream);
  return false;
}

function isLiveStream(stream: StreamEvidence): boolean {
  return (
    stream.stream === "live" ||
    (stream.domain === "traffic" &&
      ["flow", "road-conditions", "traffic-graph"].includes(stream.stream))
  );
}

const rightsIndexes = new WeakMap<CoverageCatalog, Map<string, RightsEvidence[]>>();
const datasetKey = (kind: string, owner: string, source: string): string =>
  JSON.stringify([kind, owner, source]);

export function streamSourceRights(
  stream: StreamEvidence,
  catalog: CoverageCatalog,
): RightsEvidence[] {
  // Catalogs belong to immutable revisions. Build the qualified lookup once,
  // rather than scanning every rights assertion for every matrix cell.
  let index = rightsIndexes.get(catalog);
  if (!index) {
    index = new Map();
    for (const record of catalog.rights) {
      const key = datasetKey(record.owner.kind, record.owner.id, record.sourceId);
      const records = index.get(key) ?? [];
      records.push(record);
      index.set(key, records);
    }
    rightsIndexes.set(catalog, index);
  }
  return (
    index.get(
      datasetKey(stream.owner.kind, stream.owner.id, stream.attributionSourceId ?? stream.sourceId),
    ) ?? []
  );
}
