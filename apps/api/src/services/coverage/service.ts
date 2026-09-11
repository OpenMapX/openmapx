import { randomUUID } from "node:crypto";
import {
  assessUsageRights,
  type CapabilityCandidate,
  type CapabilityResult,
  type CapabilityStatus,
  type CoverageDomain,
  type CoverageDomainOperationId,
  type CoverageReasonCode,
  type CoverageRegion,
  type CoverageRegionsResponse,
  type CoverageReport,
  type CoverageSourceDetail,
  type CoverageSourceRow,
  evaluateCapabilityCandidates,
  evaluateFreshness,
  type FreshnessStatus,
  type RightsAssessmentSummary,
  type RightsEvidence,
  type RuntimeEvidence,
  type RuntimeStatus,
  relateRegions,
  type StreamEvidence,
  type UsageAssessment,
} from "@openmapx/core/coverage";
import type { LoadedIntegration } from "@openmapx/integration-framework";
import {
  COVERAGE_OPERATION_LABELS,
  type CoverageCatalog,
  type CoverageProviderDescriptor,
  OPERATION_DEFINITIONS,
} from "./catalog.js";
import {
  type CoverageCollection,
  CoverageCollectionUnavailableError,
  type CoverageCollectorOptions,
  collectCoverageData,
  freshenStream,
  freshnessUsable,
  runtimeForProvider,
  streamSourceRights,
} from "./collect.js";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_OFFSET = 10_000_000;
const REVISION_TTL_MS = 30_000;
const MAX_REVISIONS = 4;
export const COVERAGE_REPORT_DEADLINE_MS = 5_000;

export interface CoverageReportQuery {
  regionId: string;
  snapshotId?: string;
  domain?: CoverageDomain;
  attention?: boolean;
  enabled?: boolean;
  assessment?: UsageAssessment;
  offset?: number;
  limit?: number;
}

export interface CoverageRegionsQuery {
  snapshotId?: string;
  search?: string;
  offset?: number;
  limit?: number;
}

export interface CoverageSourceQuery {
  key: string;
  regionId: string;
  snapshotId?: string;
  assessment?: UsageAssessment;
}

export class CoverageHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = "CoverageHttpError";
  }
}

interface CoverageRevision {
  snapshotId: string;
  filterKey: string;
  collected: CoverageCollection;
  createdAt: number;
  expiresAt: number;
  attentionMembership?: Map<string, string>;
}

interface RevisionOptions {
  snapshotId?: string;
  filterKey: string;
  membershipKey?: (collection: CoverageCollection) => string;
}

export interface CoverageServiceOptions extends CoverageCollectorOptions {
  collector?: (options: CoverageCollectorOptions) => Promise<CoverageCollection>;
  now?: () => Date;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function validPage(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new CoverageHttpError(400, "invalid_pagination");
  }
  return value;
}

function validOffset(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > MAX_OFFSET) {
    throw new CoverageHttpError(400, "invalid_pagination");
  }
  return value;
}

function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(timeoutError());
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sourceName(stream: StreamEvidence, catalog: CoverageCatalog): string {
  return streamSourceRights(stream, catalog)[0]?.name ?? stream.region.label ?? stream.sourceId;
}

function regionRelation(
  region: CoverageRegion,
  stream: StreamEvidence,
): StreamEvidence["region"]["relation"] {
  if (region.key === "unassigned") return "unknown";
  return relateRegions(region, stream.region).relation;
}

function streamIncludedInRegion(region: CoverageRegion, stream: StreamEvidence): boolean {
  // A source without any declared geographic scope belongs in the explicit
  // unassigned bucket. It must not be repeated in every named region merely
  // because its relation to each one is unknown.
  if (region.key === "unassigned") return stream.region.keys.length === 0;
  const hasScope = stream.region.keys.length > 0 || stream.region.bounds !== undefined;
  if (!hasScope) return false;
  return regionRelation(region, stream) !== "disjoint";
}

function relationRank(relation: StreamEvidence["region"]["relation"]): number {
  return { exact: 5, contains: 4, intersects: 3, unknown: 2, disjoint: 1 }[relation];
}

function freshnessRank(freshness: FreshnessStatus): number {
  return { current: 5, stale: 4, expired: 3, unknown: 2, "not-applicable": 1 }[freshness];
}

function combineRequiredEvidence(
  groups: readonly (readonly StreamEvidence[])[],
  region: CoverageRegion,
): ReturnType<typeof combinedEvidence> {
  const evaluations = groups.map((group) => combinedEvidence(group, region));
  const presence = evaluations.some((item) => item.presence === "not-configured")
    ? "not-configured"
    : evaluations.some((item) => item.presence === "unknown")
      ? "unknown"
      : evaluations.some((item) => item.presence === "present")
        ? "present"
        : evaluations.some((item) => item.presence === "empty")
          ? "empty"
          : "unknown";
  const relation = evaluations.some((item) => item.relation === "disjoint")
    ? "disjoint"
    : evaluations.some((item) => item.relation === "unknown")
      ? "unknown"
      : evaluations.some((item) => item.relation === "intersects")
        ? "intersects"
        : evaluations.some((item) => item.relation === "contains")
          ? "contains"
          : "exact";
  const freshness = evaluations.some((item) => item.freshness === "unknown")
    ? "unknown"
    : evaluations.some((item) => item.freshness === "expired")
      ? "expired"
      : evaluations.some((item) => item.freshness === "stale")
        ? "stale"
        : evaluations.every((item) => item.freshness === "not-applicable")
          ? "not-applicable"
          : "current";
  return {
    keys: evaluations.flatMap((item) => item.keys),
    presence,
    relation,
    freshness,
    freshnessUsable: evaluations.length > 0 && evaluations.every((item) => item.freshnessUsable),
    reasons: unique([
      ...evaluations.flatMap((item) => item.reasons),
      ...groups.flatMap((group) =>
        group.length === 0 ? (["no_publication_evidence"] as CoverageReasonCode[]) : [],
      ),
    ]),
  };
}

function combinedEvidence(
  streams: readonly StreamEvidence[],
  region: CoverageRegion,
): {
  keys: string[];
  presence: StreamEvidence["presence"];
  relation: StreamEvidence["region"]["relation"];
  freshness: FreshnessStatus;
  freshnessUsable: boolean;
  reasons: CoverageReasonCode[];
} {
  const related = streams.map((stream) => ({ stream, relation: regionRelation(region, stream) }));
  const ranked = [...related].sort(
    (a, b) =>
      relationRank(b.relation) - relationRank(a.relation) ||
      freshnessRank(b.stream.freshness) - freshnessRank(a.stream.freshness) ||
      a.stream.key.localeCompare(b.stream.key),
  );
  // Alternatives must qualify as a whole. Never combine one stream's
  // geography with another stream's presence, publication or freshness.
  const best =
    ranked.find(
      ({ stream, relation }) =>
        relation !== "disjoint" &&
        stream.publication.active === true &&
        (stream.presence === "present" || stream.presence === "empty") &&
        freshnessUsable(stream),
    ) ?? ranked[0];
  return {
    keys: best ? [best.stream.key] : [],
    presence:
      best?.stream.publication.active === true
        ? best.stream.presence
        : best?.stream.publication.active === false
          ? "not-configured"
          : "unknown",
    relation: best?.relation ?? "unknown",
    freshness: best?.stream.freshness ?? "unknown",
    freshnessUsable: best ? freshnessUsable(best.stream) : false,
    reasons: unique([
      ...(best?.stream.reasons ?? ["no_publication_evidence"]),
      ...(best?.stream.region.basis === "declared" ? ["declared_only" as const] : []),
      ...(best?.relation === "unknown" ? ["region_unknown" as const] : []),
      ...(best?.relation === "disjoint" ? ["source_disjoint" as const] : []),
    ]),
  };
}

function evidenceForProvider(
  provider: CoverageProviderDescriptor,
  operationId: CoverageDomainOperationId,
  streams: readonly StreamEvidence[],
): StreamEvidence[] {
  const byKey = (key: string): StreamEvidence[] => streams.filter((stream) => stream.key === key);
  const catalogForProvider = (): StreamEvidence[] =>
    streams.filter(
      (stream) =>
        stream.owner.kind === "integration" &&
        stream.owner.id === provider.integrationId &&
        stream.stream === "catalog",
    );
  if (operationId === "pois.search") {
    if (provider.integrationId === "poi-overture" && provider.providerId === "overture") {
      return byKey("service:data-manager:overture-places");
    }
    // The data-manager search index is only evidence for an explicitly local
    // search provider. A remote provider (including Overpass) must not borrow
    // the local index's region/publication facts merely because both serve
    // POIs; its catalog declaration remains unknown until it has a native
    // publication adapter.
    if (provider.integrationId === "search" && provider.providerId === "osm-search") {
      return byKey("service:data-manager:osm-search");
    }
    return catalogForProvider();
  }
  if (operationId === "pois.overture-enrichment") {
    return provider.integrationId === "poi-overture" && provider.providerId === "overture"
      ? byKey("service:data-manager:overture-places")
      : [];
  }
  if (operationId === "traffic.flow") return catalogForProvider();
  if (operationId === "traffic.road-conditions") return catalogForProvider();
  if (operationId === "traffic.traffic-aware-routing") return byKey("traffic:graph");
  if (provider.kind === "data-source") {
    const wanted = new Set(provider.sourceIds);
    const matches = streams.filter(
      (stream) =>
        stream.owner.kind === "integration" &&
        stream.owner.id === provider.integrationId &&
        wanted.has(stream.attributionSourceId ?? stream.sourceId) &&
        (operationId.includes("availability") || operationId.includes("occupancy")
          ? stream.stream === "live"
          : stream.stream === "static"),
    );
    return matches.length > 0
      ? matches
      : streams.filter(
          (stream) =>
            stream.owner.kind === "integration" &&
            stream.owner.id === provider.integrationId &&
            stream.stream === "catalog",
        );
  }
  if (provider.kind === "transit") {
    if (
      provider.integrationId === "transit-motis" &&
      provider.providerId === "transit-motis-local"
    ) {
      return streams.filter(
        (stream) =>
          stream.owner.kind === "service" &&
          stream.owner.id === "data-manager" &&
          stream.stream === "schedule",
      );
    }
    return catalogForProvider();
  }
  if (provider.kind === "realtime") return catalogForProvider();
  if (provider.kind === "geocoding") {
    return streams.filter(
      (stream) =>
        stream.owner.kind === "integration" &&
        stream.owner.id === provider.integrationId &&
        stream.stream === "catalog",
    );
  }
  return [];
}

function rightsForStreams(
  streams: readonly StreamEvidence[],
  catalog: CoverageCatalog,
): RightsEvidence[] {
  const records = streams.flatMap((stream): RightsEvidence[] => {
    const rights = streamSourceRights(stream, catalog);
    return rights.length > 0
      ? rights
      : [
          {
            key: `unknown:${stream.key}`,
            qualifiedDatasetKey: stream.key,
            owner: stream.owner,
            sourceId: stream.attributionSourceId ?? stream.sourceId,
            commercialUse: "unknown",
            redistribution: { sourceData: "unknown", derivedData: "unknown" },
            usageConditions: [],
            lineageKnown: false,
          },
        ];
  });
  return [...new Map(records.map((record) => [record.key, record])).values()];
}

function policyExcluded(
  rights: readonly RightsEvidence[],
  policy: CoverageCollection["policy"],
): boolean {
  if (!policy || rights.length === 0) return false;
  return rights.every(
    (right) =>
      (right.commercialUse === "no" && !policy.allowNonCommercial) ||
      (right.commercialUse === "unknown" && !policy.allowGreyArea),
  );
}

function bindingFor(
  provider: CoverageProviderDescriptor,
  collection: CoverageCollection,
): CapabilityCandidate["binding"] {
  const integration = collection.catalog.integrations.find(
    (item) => item.id === provider.integrationId,
  );
  if (!integration) return "unknown";
  if (!(integration.manifest.requires ?? []).some((req) => !req.optional)) return "not-required";
  return collection.requirementStates?.get(integration.id) ?? "unknown";
}

function providerRuntime(
  provider: CoverageProviderDescriptor,
  collection: CoverageCollection,
  now: Date,
): { status: RuntimeStatus; reason?: CoverageReasonCode; evidence?: RuntimeEvidence } {
  const runtime = runtimeForProvider(provider, collection, now);
  const snapshot = runtime.snapshot;
  return {
    status: runtime.status,
    ...(runtime.reason ? { reason: runtime.reason } : {}),
    ...(runtime.observedAt
      ? {
          evidence: {
            key: `runtime:${provider.integrationId}:${provider.providerId}`.slice(0, 512),
            owner: { kind: "integration", id: provider.integrationId },
            providerId: provider.providerId,
            status: runtime.status,
            observedAt: runtime.observedAt,
            validUntil: runtime.observedAt
              ? new Date(
                  Date.parse(runtime.observedAt) + (runtime.maxAgeMs ?? PASSIVE_HEALTH_MAX_AGE_MS),
                ).toISOString()
              : null,
            policy: {
              basis:
                runtime.origin === "scheduled"
                  ? "scheduled-health-check"
                  : "passive-provider-observation",
              maxAgeSeconds: (runtime.maxAgeMs ?? PASSIVE_HEALTH_MAX_AGE_MS) / 1000,
              version: "coverage-v1",
              provenance:
                runtime.origin === "scheduled"
                  ? "Cached integration health check"
                  : "Redis circuit observation; no probe was acquired",
            },
            ...(runtime.reason ? { reason: runtime.reason } : {}),
            ...(snapshot?.lastOperatorMessage
              ? { message: snapshot.lastOperatorMessage.slice(0, 500) }
              : {}),
          },
        }
      : {}),
  };
}

const PASSIVE_HEALTH_MAX_AGE_MS = 300_000;

function candidateFor(
  provider: CoverageProviderDescriptor,
  operationId: CoverageDomainOperationId,
  collection: CoverageCollection,
  region: CoverageRegion,
  now: Date,
  extraEvidence: readonly StreamEvidence[] = [],
): { candidate: CapabilityCandidate; runtime?: RuntimeEvidence } {
  return candidateFromEvidenceGroups(provider, operationId, collection, region, now, [
    [...evidenceForProvider(provider, operationId, collection.streams), ...extraEvidence],
  ]);
}

function candidateFromEvidenceGroups(
  provider: CoverageProviderDescriptor,
  operationId: CoverageDomainOperationId,
  collection: CoverageCollection,
  region: CoverageRegion,
  now: Date,
  groups: readonly (readonly StreamEvidence[])[],
): { candidate: CapabilityCandidate; runtime?: RuntimeEvidence } {
  const freshGroups = groups.map((group) => {
    const allowed = group.filter(
      (stream) =>
        !policyExcluded(streamSourceRights(stream, collection.catalog), collection.policy),
    );
    return (allowed.length > 0 ? allowed : group).map((stream) => freshenStream(stream, now));
  });
  const fresh = freshGroups.flat();
  const combined =
    freshGroups.length === 1
      ? combinedEvidence(fresh, region)
      : combineRequiredEvidence(freshGroups, region);
  const rights = rightsForStreams(
    fresh.filter((stream) => combined.keys.includes(stream.key)),
    collection.catalog,
  );
  const runtime = providerRuntime(provider, collection, now);
  const reasons = [...combined.reasons];
  if (runtime.reason) reasons.push(runtime.reason);
  if (policyExcluded(rights, collection.policy)) reasons.push("policy_excluded");
  const operationSupported = provider.supports[operationId] ?? "unknown";
  const binding = bindingFor(provider, collection);
  return {
    candidate: {
      id: provider.candidateId,
      providerId: provider.providerId,
      label: provider.label,
      enabled: provider.enabled,
      operationSupported,
      binding,
      runtime: runtime.status,
      presence: combined.presence,
      regionRelation: combined.relation,
      freshness: combined.freshness,
      freshnessUsable: combined.freshnessUsable,
      requiredEvidenceKeys: combined.keys,
      reasons: unique(reasons),
      ...(rights.length === 0 ? { optionalReasons: ["rights_unknown"] } : {}),
    },
    ...(runtime.evidence ? { runtime: runtime.evidence } : {}),
  };
}

function combineBindings(
  left: CapabilityCandidate["binding"],
  right: CapabilityCandidate["binding"],
): CapabilityCandidate["binding"] {
  if (left === "missing" || right === "missing") return "missing";
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "resolved" || right === "resolved") return "resolved";
  return "not-required";
}

function combineRuntimeStatuses(left: RuntimeStatus, right: RuntimeStatus): RuntimeStatus {
  if (left === "down" || right === "down") return "down";
  if (left === "unconfigured" || right === "unconfigured") return "unconfigured";
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "degraded" || right === "degraded") return "degraded";
  return "up";
}

function evStaticEvidence(
  provider: CoverageProviderDescriptor,
  collection: CoverageCollection,
): StreamEvidence[] {
  const wanted = new Set(provider.sourceIds);
  return collection.streams.filter(
    (stream) =>
      stream.domain === "ev" &&
      stream.stream === "static" &&
      stream.owner.kind === "integration" &&
      stream.owner.id === provider.integrationId &&
      wanted.has(stream.attributionSourceId ?? stream.sourceId),
  );
}

function routingEvidence(
  provider: CoverageProviderDescriptor,
  collection: CoverageCollection,
): StreamEvidence[] {
  // Traffic overlays are optional for EV routing and do not establish the
  // identity, coverage or validity of the router's base graph.
  return evidenceForProvider(provider, "addresses.forward-search", collection.streams);
}

function evRouteCandidate(
  routing: CoverageProviderDescriptor,
  charger: CoverageProviderDescriptor,
  collection: CoverageCollection,
  region: CoverageRegion,
  now: Date,
): {
  candidate: CapabilityCandidate;
  runtime: Array<{ key: string; evidence: RuntimeEvidence }>;
} {
  const operationId = "ev.route-planning" as const;
  const freshGroups = [
    evStaticEvidence(charger, collection),
    routingEvidence(routing, collection),
  ].map((group) => group.map((stream) => freshenStream(stream, now)));
  const combined = combineRequiredEvidence(freshGroups, region);
  const routingRuntime = providerRuntime(routing, collection, now);
  const chargerRuntime = providerRuntime(charger, collection, now);
  const reasons = unique([
    ...combined.reasons,
    ...(routingRuntime.reason ? [routingRuntime.reason] : []),
    ...(chargerRuntime.reason ? [chargerRuntime.reason] : []),
  ]);
  const runtime = combineRuntimeStatuses(routingRuntime.status, chargerRuntime.status);
  const binding = combineBindings(bindingFor(routing, collection), bindingFor(charger, collection));
  const rights = rightsForStreams(freshGroups.flat(), collection.catalog);
  const candidate: CapabilityCandidate = {
    id: `${routing.candidateId}+charger:${charger.candidateId}`.slice(0, 512),
    providerId: `${routing.providerId}+${charger.providerId}`.slice(0, 256),
    label: `${routing.label} + ${charger.label}`.slice(0, 512),
    enabled: routing.enabled && charger.enabled,
    operationSupported:
      routing.supports[operationId] === true && charger.supports[operationId] === true,
    binding,
    runtime,
    presence: combined.presence,
    regionRelation: combined.relation,
    freshness: combined.freshness,
    freshnessUsable: combined.freshnessUsable,
    requiredEvidenceKeys: combined.keys,
    reasons,
    ...(rights.length === 0 ? { optionalReasons: ["rights_unknown"] } : {}),
  };
  const runtimeEvidence: Array<{ key: string; evidence: RuntimeEvidence }> = [];
  if (routingRuntime.evidence) {
    runtimeEvidence.push({ key: routing.candidateId, evidence: routingRuntime.evidence });
  }
  if (chargerRuntime.evidence) {
    runtimeEvidence.push({ key: charger.candidateId, evidence: chargerRuntime.evidence });
  }
  return { candidate, runtime: runtimeEvidence };
}

function missingCandidate(operationId: CoverageDomainOperationId): CapabilityCandidate {
  return {
    id: `missing:${operationId}`,
    providerId: "none",
    label: "No registered provider",
    enabled: false,
    operationSupported: "unknown",
    binding: "unknown",
    runtime: "unknown",
    presence: "unknown",
    regionRelation: "unknown",
    freshness: "unknown",
    freshnessUsable: false,
    requiredEvidenceKeys: [],
    reasons: ["binding_missing", "no_publication_evidence"],
  };
}

function domainSummary(
  domain: CoverageDomain,
  capabilities: readonly CapabilityResult[],
): CoverageReport["summary"][number] {
  const selected = capabilities.filter((capability) => capability.domain === domain);
  const counts = {
    operational: selected.filter((item) => item.status === "operational").length,
    limited: selected.filter((item) => item.status === "limited").length,
    unavailable: selected.filter((item) => item.status === "unavailable").length,
    unknown: selected.filter((item) => item.status === "unknown").length,
  };
  const status: CapabilityStatus =
    selected.length > 0 && counts.operational === selected.length
      ? "operational"
      : counts.operational > 0 || counts.limited > 0
        ? "limited"
        : counts.unknown > 0
          ? "unknown"
          : "unavailable";
  return {
    domain,
    status,
    ...counts,
    attention: selected.filter((item) => item.status !== "operational").length,
    reasons: unique(selected.flatMap((item) => item.reasons)),
  };
}

function sourceRow(
  stream: StreamEvidence,
  region: CoverageRegion,
  catalog: CoverageCatalog,
  assessment: UsageAssessment,
  integrations: readonly LoadedIntegration[],
  now: Date,
): CoverageSourceRow {
  const relation = regionRelation(region, stream);
  const rights = streamSourceRights(stream, catalog);
  const integration =
    stream.owner.kind === "integration"
      ? integrations.find((item) => item.id === stream.owner.id)
      : undefined;
  const enabled = stream.owner.kind === "service" ? true : (integration?.enabled ?? false);
  const assessed = assessUsageRights(rights, assessment);
  const reasons = unique([
    ...stream.reasons,
    ...assessed.reasons,
    ...(relation === "unknown" ? (["region_unknown"] as CoverageReasonCode[]) : []),
    ...(relation === "disjoint" ? (["source_disjoint"] as CoverageReasonCode[]) : []),
  ]);
  const correctiveLinks: CoverageSourceRow["correctiveLinks"] = [];
  if (integration) {
    correctiveLinks.push({
      label: "Integration settings",
      href: `/admin/integrations/${encodeURIComponent(integration.id)}`,
    });
  }
  if (stream.owner.kind === "service")
    correctiveLinks.push({ label: "Data services", href: "/admin/services" });
  if (stream.domain === "transit") {
    correctiveLinks.push({ label: "Transit sources", href: "/admin/transit" });
  }
  if (stream.stream === "static" || stream.stream === "live") {
    correctiveLinks.push({ label: "POI ingest", href: "/admin/poi-ingest" });
  }
  return {
    key: stream.key,
    sourceId: stream.sourceId,
    name: sourceName(stream, catalog),
    ...(stream.count ? { count: stream.count } : {}),
    owner: stream.owner,
    domain: stream.domain,
    stream: stream.stream,
    enabled,
    active: stream.publication.active,
    region: { ...stream.region, relation },
    presence: stream.presence,
    freshness: stream.freshness,
    lastAttemptAt: stream.attempt.at,
    lastSuccessfulCheckAt: stream.lastSuccessfulCheckAt,
    lastPublishedAt: stream.publication.publishedAt,
    upstreamAsOf: stream.upstreamAsOf,
    expiresAt: stream.expiresAt,
    latestAttempt: stream.attempt,
    freshnessDeadline: evaluateFreshness({
      now: now.getTime(),
      presence: stream.presence,
      activeVersion: stream.publication.version,
      lastSuccessfulCheckAt: stream.lastSuccessfulCheckAt,
      lastSuccessfullyCheckedVersion: stream.lastSuccessfullyCheckedVersion,
      upstreamAsOf: stream.upstreamAsOf,
      expiresAt: stream.expiresAt,
      policy: stream.policy,
    }).deadline,
    rights: assessed,
    reasons,
    correctiveLinks,
  };
}

function sourceRowsFor(
  collection: CoverageCollection,
  region: CoverageRegion,
  assessment: UsageAssessment,
  now: Date,
  query: Pick<CoverageReportQuery, "domain" | "attention" | "enabled"> = {},
): CoverageSourceRow[] {
  return collection.streams
    .filter(
      (stream) =>
        streamIncludedInRegion(region, stream) && (!query.domain || stream.domain === query.domain),
    )
    .map((stream) =>
      sourceRow(
        freshenStream(stream, now),
        region,
        collection.catalog,
        assessment,
        collection.catalog.integrations,
        now,
      ),
    )
    .filter((row) => {
      if (query.domain && row.domain !== query.domain) return false;
      if (query.attention && !needsAttention(row)) return false;
      if (query.enabled !== undefined && row.enabled !== query.enabled) return false;
      return true;
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function needsAttention(row: CoverageSourceRow): boolean {
  return (
    row.reasons.some((reason) => reason !== "empty_observation") ||
    !["current", "not-applicable"].includes(row.freshness) ||
    ["review-required", "not-permitted", "conditions-apply"].includes(row.rights.status)
  );
}

function nextDeadlineAt(rows: readonly CoverageSourceRow[], now: Date): string | null {
  const timestamp = rows
    .map((row) => (row.freshnessDeadline ? Date.parse(row.freshnessDeadline) : Number.NaN))
    .filter((value) => Number.isFinite(value) && value > now.getTime())
    .sort((a, b) => a - b)[0];
  return timestamp === undefined ? null : new Date(timestamp).toISOString();
}

export class CoverageService {
  private readonly revisions = new Map<string, CoverageRevision>();
  private readonly now: () => Date;
  private readonly collector: (options: CoverageCollectorOptions) => Promise<CoverageCollection>;
  private readonly collectorOptions: CoverageCollectorOptions;
  private rawInFlight: Promise<CoverageCollection> | null = null;
  private rawCollection: { value: CoverageCollection; expiresAt: number } | null = null;

  constructor(options: CoverageServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.collector = options.collector ?? collectCoverageData;
    this.collectorOptions = options;
  }

  private evict(): void {
    const timestamp = this.now().getTime();
    for (const [id, revision] of this.revisions) {
      if (revision.expiresAt <= timestamp) this.revisions.delete(id);
    }
  }

  private async raw(): Promise<CoverageCollection> {
    const timestamp = this.now().getTime();
    if (this.rawCollection && this.rawCollection.expiresAt > timestamp)
      return this.rawCollection.value;
    if (!this.rawInFlight) {
      const collection = this.collector(this.collectorOptions);
      this.rawInFlight = withDeadline(
        collection,
        COVERAGE_REPORT_DEADLINE_MS,
        () => new CoverageCollectionUnavailableError("coverage collection deadline exceeded"),
      ).finally(() => {
        this.rawInFlight = null;
      });
    }
    const value = await this.rawInFlight;
    this.rawCollection = { value, expiresAt: timestamp + REVISION_TTL_MS };
    return value;
  }

  private async revision(options: RevisionOptions): Promise<CoverageRevision> {
    this.evict();
    if (options.snapshotId) {
      const existing = this.revisions.get(options.snapshotId);
      // A composite revision contains the complete evidence collection. The
      // report and source views may apply different presentation filters to
      // that same revision, which is what lets a source drawer stay pinned to
      // the report the operator opened.
      if (!existing) {
        throw new CoverageHttpError(409, "snapshot_expired");
      }
      if (
        options.membershipKey &&
        existing.attentionMembership?.get(options.filterKey) !== undefined &&
        existing.attentionMembership.get(options.filterKey) !==
          options.membershipKey(existing.collected)
      ) {
        throw new CoverageHttpError(409, "snapshot_expired");
      }
      if (options.membershipKey) {
        existing.attentionMembership ??= new Map();
        existing.attentionMembership.set(
          options.filterKey,
          options.membershipKey(existing.collected),
        );
      }
      return existing;
    }
    const existing = [...this.revisions.values()]
      .reverse()
      .find((revision) => revision.filterKey === options.filterKey);
    if (
      existing &&
      (!options.membershipKey ||
        existing.attentionMembership?.get(options.filterKey) ===
          options.membershipKey(existing.collected))
    )
      return existing;
    const collected = await this.raw();
    const revision: CoverageRevision = {
      snapshotId: randomUUID(),
      filterKey: options.filterKey,
      collected,
      createdAt: this.now().getTime(),
      expiresAt: this.now().getTime() + REVISION_TTL_MS,
      ...(options.membershipKey
        ? { attentionMembership: new Map([[options.filterKey, options.membershipKey(collected)]]) }
        : {}),
    };
    this.revisions.set(revision.snapshotId, revision);
    while (this.revisions.size > MAX_REVISIONS) {
      const oldest = this.revisions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.revisions.delete(oldest);
    }
    return revision;
  }

  private evaluateCapabilities(
    collection: CoverageCollection,
    region: CoverageRegion,
    assessment: UsageAssessment,
    now: Date,
  ): { capabilities: CapabilityResult[]; runtimeEvidence: Map<string, RuntimeEvidence> } {
    const runtimeEvidence = new Map<string, RuntimeEvidence>();
    const capabilities = OPERATION_DEFINITIONS.map((definition) => {
      let providers = collection.catalog.providers.filter(
        (provider) => provider.supports[definition.id] !== undefined,
      );
      if (definition.id === "ev.route-planning") {
        providers = providers.filter(
          (provider) => provider.kind === "data-source" || provider.kind === "routing",
        );
      }
      const candidates: CapabilityCandidate[] = [];
      if (definition.id === "ev.route-planning") {
        const routingProviders = providers.filter(
          (provider) => provider.kind === "routing" && provider.supports[definition.id] === true,
        );
        const chargerProviders = providers.filter(
          (provider) =>
            provider.kind === "data-source" && provider.supports[definition.id] === true,
        );
        if (routingProviders.length > 0 && chargerProviders.length > 0) {
          // EV routing is a conjunction, not an alternative-provider lookup:
          // a route planner and a charger data source must be usable together.
          // Emit one candidate per dispatchable pair so a current graph cannot
          // rescue a missing charger publication (or vice versa).
          for (const routing of routingProviders) {
            for (const charger of chargerProviders) {
              const built = evRouteCandidate(routing, charger, collection, region, now);
              candidates.push(built.candidate);
              for (const runtime of built.runtime) {
                runtimeEvidence.set(runtime.key, runtime.evidence);
              }
            }
          }
        } else {
          for (const provider of providers) {
            const built = candidateFor(provider, definition.id, collection, region, now);
            candidates.push({
              ...built.candidate,
              operationSupported: false,
              reasons: unique([...built.candidate.reasons, "operation_unsupported"]),
            });
            if (built.runtime) runtimeEvidence.set(provider.candidateId, built.runtime);
          }
        }
      } else {
        for (const provider of providers) {
          const built = candidateFor(provider, definition.id, collection, region, now);
          candidates.push(built.candidate);
          if (built.runtime) runtimeEvidence.set(provider.candidateId, built.runtime);
        }
      }
      if (candidates.length === 0) candidates.push(missingCandidate(definition.id));
      const rights = rightsForStreams(
        candidates.flatMap((candidate) =>
          collection.streams.filter((stream) =>
            candidate.requiredEvidenceKeys.includes(stream.key),
          ),
        ),
        collection.catalog,
      );
      const policyState =
        collection.policy === null
          ? "unknown"
          : policyExcluded(rights, collection.policy)
            ? "excluded"
            : "allowed";
      const result = evaluateCapabilityCandidates({
        operationId: definition.id,
        domain: definition.domain,
        candidates,
        policyState,
      });
      const rank = { operational: 4, limited: 3, unknown: 2, unavailable: 1 };
      const selected = [...result.candidates].sort((a, b) => rank[b.status] - rank[a.status])[0];
      const selectedRights = rightsForStreams(
        collection.streams.filter((stream) => selected?.requiredEvidenceKeys.includes(stream.key)),
        collection.catalog,
      );
      const operationRights = assessUsageRights(selectedRights, assessment);
      return { ...result, operationRights } as CapabilityResult & {
        operationRights: RightsAssessmentSummary;
      };
    });
    return { capabilities, runtimeEvidence };
  }

  private baseMetadata(
    revision: CoverageRevision,
    now: Date,
  ): Pick<
    CoverageReport,
    | "schemaVersion"
    | "snapshotId"
    | "generatedAt"
    | "evaluatedAt"
    | "collectionStatus"
    | "collectionAgeSeconds"
    | "warnings"
    | "authorities"
  > {
    const collection = revision.collected;
    const evaluatedAt = now.toISOString();
    const generatedTime = Date.parse(collection.generatedAt);
    const age = Number.isFinite(generatedTime)
      ? Math.max(0, (now.getTime() - generatedTime) / 1000)
      : Number.POSITIVE_INFINITY;
    const warnings = [...collection.warnings];
    if (age > 120 && !warnings.includes("collector_timed_out"))
      warnings.push("collector_timed_out");
    return {
      schemaVersion: 1,
      snapshotId: revision.snapshotId,
      generatedAt: collection.generatedAt,
      evaluatedAt,
      collectionStatus: collection.collectionStatus,
      collectionAgeSeconds: age,
      warnings: unique(warnings),
      authorities: collection.authorities,
    };
  }

  private regionOrThrow(collection: CoverageCollection, regionId: string): CoverageRegion {
    const region = collection.regions.find((candidate) => candidate.key === regionId);
    if (!region) throw new CoverageHttpError(404, "region_not_found");
    return region;
  }

  private attentionMembershipKey(
    collection: CoverageCollection,
    query: Pick<CoverageReportQuery, "regionId" | "domain" | "enabled" | "assessment">,
  ): string {
    const region = collection.regions.find((candidate) => candidate.key === query.regionId);
    if (!region) return `missing-region:${query.regionId}`;
    const rows = sourceRowsFor(collection, region, query.assessment ?? "operational", this.now(), {
      domain: query.domain,
      attention: true,
      enabled: query.enabled,
    });
    return JSON.stringify(rows.map((row) => row.key));
  }

  async regions(query: CoverageRegionsQuery = {}): Promise<CoverageRegionsResponse> {
    const offset = validOffset(query.offset);
    if (offset > 0 && !query.snapshotId) throw new CoverageHttpError(400, "snapshot_required");
    const limit = validPage(query.limit, DEFAULT_PAGE_LIMIT);
    const filterKey = `regions:${query.search ?? ""}`;
    const revision = await this.revision({ snapshotId: query.snapshotId, filterKey });
    const now = this.now();
    const search = query.search?.toLocaleLowerCase() ?? "";
    const regions = revision.collected.regions.filter(
      (region) => !search || `${region.key} ${region.label}`.toLocaleLowerCase().includes(search),
    );
    const rows = regions.slice(offset, offset + limit).map((region) => {
      const evaluated = this.evaluateCapabilities(
        revision.collected,
        region,
        "operational",
        now,
      ).capabilities;
      const domains = Object.fromEntries(
        ["addresses", "pois", "transit", "ev", "parking", "traffic"].map((domain) => [
          domain,
          domainSummary(domain as CoverageDomain, evaluated),
        ]),
      ) as CoverageRegionsResponse["regions"][number]["domains"];
      const sourceRows = sourceRowsFor(revision.collected, region, "operational", now);
      return {
        region,
        domains,
        sourceCount: sourceRows.length,
        attentionCount: sourceRows.filter(needsAttention).length,
      };
    });
    const page = rows;
    const metadata = this.baseMetadata(revision, now);
    return {
      ...metadata,
      regions: page,
      total: regions.length,
      unassignedSourceCount: revision.collected.unassignedSourceCount,
      pagination: {
        offset,
        limit,
        total: regions.length,
        hasMore: offset + page.length < regions.length,
        snapshotId: revision.snapshotId,
      },
    };
  }

  async report(query: CoverageReportQuery): Promise<CoverageReport> {
    const offset = validOffset(query.offset);
    if (offset > 0 && !query.snapshotId) throw new CoverageHttpError(400, "snapshot_required");
    const limit = validPage(query.limit, DEFAULT_PAGE_LIMIT);
    const assessment = query.assessment ?? "operational";
    const filterKey = [
      "report",
      query.regionId,
      query.domain ?? "all",
      query.attention ? "attention" : "all-status",
      query.enabled === undefined ? "all" : query.enabled ? "enabled" : "disabled",
      assessment,
    ].join(":");
    const revision = await this.revision({
      snapshotId: query.snapshotId,
      filterKey,
      ...(query.attention
        ? { membershipKey: (collection) => this.attentionMembershipKey(collection, query) }
        : {}),
    });
    const now = this.now();
    const region = this.regionOrThrow(revision.collected, query.regionId);
    const evaluated = this.evaluateCapabilities(revision.collected, region, assessment, now);
    const capabilities = evaluated.capabilities;
    const operations = capabilities.map((capability) => ({
      operationId: capability.operationId,
      label: COVERAGE_OPERATION_LABELS[capability.operationId],
      status: capability.status,
      reasons: capability.reasons,
      evidenceKeys: capability.evidenceKeys,
      rights:
        (capability as CapabilityResult & { operationRights?: RightsAssessmentSummary })
          .operationRights ?? assessUsageRights([], assessment),
    }));
    const allSources = sourceRowsFor(revision.collected, region, assessment, now, query);
    const page = allSources.slice(offset, offset + limit);
    const metadata = this.baseMetadata(revision, now);
    const ageSeconds = metadata.collectionAgeSeconds;
    const summary = ["addresses", "pois", "transit", "ev", "parking", "traffic"].map((domain) =>
      domainSummary(domain as CoverageDomain, capabilities),
    );
    const policy = revision.collected.policy;
    const gatedSources = policy
      ? revision.collected.catalog.rights.filter(
          (right) =>
            (right.commercialUse === "no" && !policy.allowNonCommercial) ||
            (right.commercialUse === "unknown" && !policy.allowGreyArea),
        ).length
      : 0;
    const gatedIntegrations = policy
      ? new Set(
          revision.collected.catalog.integrations
            .filter((integration) => {
              const rights = revision.collected.catalog.rights.filter(
                (right) => right.owner.kind === "integration" && right.owner.id === integration.id,
              );
              return (
                rights.length > 0 &&
                rights.every(
                  (right) =>
                    (right.commercialUse === "no" && !policy.allowNonCommercial) ||
                    (right.commercialUse === "unknown" && !policy.allowGreyArea),
                )
              );
            })
            .map((integration) => integration.id),
        ).size
      : 0;
    return {
      ...metadata,
      region,
      summary,
      capabilities,
      operations,
      sources: page,
      sourcePagination: {
        offset,
        limit,
        total: allSources.length,
        hasMore: offset + page.length < allSources.length,
        snapshotId: revision.snapshotId,
      },
      totalSourceCount: allSources.length,
      unassignedSourceCount: revision.collected.unassignedSourceCount,
      assessment,
      nextDeadlineAt:
        [
          nextDeadlineAt(allSources, now),
          ...[...evaluated.runtimeEvidence.values()].map((evidence) => evidence.validUntil),
        ]
          .filter((value): value is string => value !== null && Date.parse(value) > now.getTime())
          .sort()[0] ?? null,
      policy: {
        effectiveSourcePolicy: policy
          ? policy.allowNonCommercial && policy.allowGreyArea
            ? "permissive"
            : "restricted"
          : "unknown",
        gatedSourceCount: gatedSources,
        gatedIntegrationCount: gatedIntegrations,
      },
      collectionAgeSeconds: ageSeconds,
    };
  }

  async source(query: CoverageSourceQuery): Promise<CoverageSourceDetail> {
    const assessment = query.assessment ?? "operational";
    const filterKey = `source:${query.regionId}:${query.key}:${assessment}`;
    const revision = await this.revision({ snapshotId: query.snapshotId, filterKey });
    const now = this.now();
    const region = this.regionOrThrow(revision.collected, query.regionId);
    const original = revision.collected.streams.find((stream) => stream.key === query.key);
    if (!original || !streamIncludedInRegion(region, original))
      throw new CoverageHttpError(404, "source_not_found");
    const evidence = freshenStream(original, now);
    const row = sourceRow(
      evidence,
      region,
      revision.collected.catalog,
      assessment,
      revision.collected.catalog.integrations,
      now,
    );
    const rights = streamSourceRights(evidence, revision.collected.catalog);
    const provider = revision.collected.catalog.providers.find(
      (candidate) =>
        evidence.owner.kind === "integration" &&
        candidate.integrationId === evidence.owner.id &&
        candidate.sourceIds.includes(evidence.attributionSourceId ?? evidence.sourceId),
    );
    let runtime: RuntimeEvidence | undefined;
    if (provider) runtime = providerRuntime(provider, revision.collected, now).evidence;
    const metadata = this.baseMetadata(revision, now);
    return {
      ...metadata,
      source: row,
      evidence,
      ...(runtime ? { runtime } : {}),
      rights,
      lineage: rights.map((right) => ({
        fromKey: right.key,
        toKey: evidence.key,
        relation: "declared contributor",
      })),
      recentAttempts: [{ ...evidence.attempt, key: evidence.key }].slice(0, 20),
      warnings: metadata.warnings,
    };
  }

  /** Test/diagnostic hook; no report endpoint exposes raw revisions. */
  revisionStats(): { count: number; rawCached: boolean } {
    this.evict();
    return { count: this.revisions.size, rawCached: this.rawCollection !== null };
  }
}

export function createCoverageService(options: CoverageServiceOptions = {}): CoverageService {
  return new CoverageService(options);
}
