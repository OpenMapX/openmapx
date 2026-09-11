/** The six operational domains shown by the coverage report. */
export type CoverageDomain = "addresses" | "pois" | "transit" | "ev" | "parking" | "traffic";

export type CoveragePermission = "yes" | "no" | "conditional" | "unknown";

export type EvidencePresence = "present" | "empty" | "not-configured" | "unknown";

export type GeographicEvidenceBasis = "declared" | "published-region" | "observed" | "unknown";

export type RegionRelation = "exact" | "contains" | "intersects" | "disjoint" | "unknown";

export type FreshnessStatus = "current" | "stale" | "expired" | "unknown" | "not-applicable";

export type AttemptOutcome =
  | "running"
  | "succeeded"
  | "unchanged"
  | "partial"
  | "failed"
  | "skipped"
  | "unknown";

export type RuntimeStatus = "up" | "degraded" | "down" | "unconfigured" | "unknown";

export type CapabilityStatus = "operational" | "limited" | "unavailable" | "unknown";

export type RightsAssessmentStatus =
  | "permitted"
  | "conditions-apply"
  | "not-permitted"
  | "review-required"
  | "not-applicable";

export type CollectionStatus = "complete" | "partial" | "unavailable";

export type AuthorityStatus = "available" | "partial" | "unavailable";

export type UsageAssessment =
  | "operational"
  | "commercial"
  | "redistribute-source-data"
  | "redistribute-derived-data";

export type CoverageReasonCode =
  | "not_configured"
  | "region_unknown"
  | "declared_only"
  | "no_publication_evidence"
  | "upstream_check_failed"
  | "publish_failed"
  | "active_version_mismatch"
  | "freshness_policy_missing"
  | "live_expired"
  | "schedule_validity_unknown"
  | "collector_unavailable"
  | "health_unobserved"
  | "rights_unknown"
  | "rights_conflict"
  | "conditions_apply"
  | "policy_excluded"
  | "lineage_unknown"
  | "clock_invalid"
  | "source_disjoint"
  | "source_partial"
  | "runtime_down"
  | "runtime_degraded"
  | "binding_missing"
  | "operation_unsupported"
  | "optional_evidence_missing"
  | "serving_earlier_data"
  | "collector_timed_out"
  | "schema_unavailable"
  | "data_manager_unavailable"
  | "evidence_truncated"
  | "version_unverified"
  | "source_not_active"
  | "empty_observation";

export type CoverageDomainOperationId =
  | "addresses.forward-search"
  | "addresses.reverse-geocoding"
  | "pois.search"
  | "pois.overture-enrichment"
  | "transit.stop-search"
  | "transit.departures"
  | "transit.journey-planning"
  | "transit.realtime"
  | "ev.charger-discovery"
  | "ev.charger-availability"
  | "ev.route-planning"
  | "parking.facility-discovery"
  | "parking.occupancy"
  | "traffic.flow"
  | "traffic.road-conditions"
  | "traffic.traffic-aware-routing";

export type RegionKey = string;

export type Wgs84Bounds = readonly [number, number, number, number];

export interface JobReference {
  system: "application" | "data-manager";
  id: string;
}

export interface EvidenceOwner {
  kind: "integration" | "service";
  id: string;
}

export interface EvidenceCount {
  value: number;
  unit: string;
  scope: string;
}

export interface EvidencePublication {
  version: string | null;
  publishedAt: string | null;
  active: boolean | null;
}

export interface EvidenceAttempt {
  at: string | null;
  outcome: AttemptOutcome;
  job?: JobReference;
  reasonCode?: CoverageReasonCode;
  message?: string;
}

export interface FreshnessPolicy {
  basis: string;
  expectedIntervalSeconds?: number | null;
  staleAt: string | null;
  expiresAt?: string | null;
  version: string;
  provenance: string;
}

export interface StreamRegionEvidence {
  keys: RegionKey[];
  basis: GeographicEvidenceBasis;
  relation: RegionRelation;
  bounds?: Wgs84Bounds;
  label?: string;
}

export interface RoadConditionOperationalMetrics {
  status: string;
  action: string | null;
  changedCount: number | null;
  rejectedCount: number | null;
  consecutiveFailures: number | null;
  bindingCounts: Record<string, number> | null;
  graph: {
    generation: string | null;
    status: "ready" | "partial" | "missing" | "unknown";
    regions: string[];
  };
}

export interface StreamEvidence {
  roadConditions?: RoadConditionOperationalMetrics;
  /** Opaque deterministic key derived from qualified upstream identity. */
  key: string;
  owner: EvidenceOwner;
  sourceId: string;
  attributionSourceId?: string;
  stream: string;
  consumerInstance?: string;
  domain: CoverageDomain;
  observedAt: string;
  evidenceVersion: 1;
  presence: EvidencePresence;
  region: StreamRegionEvidence;
  count?: EvidenceCount;
  publication: EvidencePublication;
  attempt: EvidenceAttempt;
  lastSuccessfulCheckAt: string | null;
  lastSuccessfullyCheckedVersion: string | null;
  upstreamAsOf: string | null;
  expiresAt: string | null;
  policy: FreshnessPolicy;
  freshness: FreshnessStatus;
  reasons: CoverageReasonCode[];
}

export interface RuntimeEvidence {
  key: string;
  owner: EvidenceOwner;
  providerId: string;
  status: RuntimeStatus;
  observedAt: string | null;
  validUntil: string | null;
  policy: {
    basis: string;
    maxAgeSeconds: number | null;
    version: string;
    provenance: string;
  };
  reason?: CoverageReasonCode;
  message?: string;
}

export interface RedistributionPermissions {
  sourceData: CoveragePermission;
  derivedData: CoveragePermission;
}

export interface RightsEvidence {
  key: string;
  qualifiedDatasetKey: string;
  owner: EvidenceOwner;
  sourceId: string;
  name?: string;
  commercialUse: CoveragePermission;
  redistribution: RedistributionPermissions;
  license?: string;
  licenseUrl?: string;
  termsUrl?: string;
  attribution?: string;
  usageConditions: string[];
  reviewedAt?: string;
  evidenceOrigin?: string;
  conflict?: boolean;
  lineageKnown: boolean;
}

export interface CapabilityCandidate {
  id: string;
  providerId: string;
  label?: string;
  enabled: boolean;
  operationSupported: boolean | "unknown";
  binding: "resolved" | "not-required" | "missing" | "unknown";
  runtime: RuntimeStatus;
  presence: EvidencePresence;
  regionRelation: RegionRelation;
  freshness: FreshnessStatus;
  freshnessUsable: boolean;
  requiredEvidenceKeys: string[];
  optionalEvidenceKeys?: string[];
  reasons: CoverageReasonCode[];
  optionalReasons?: CoverageReasonCode[];
}

export interface EvaluatedCapabilityCandidate extends CapabilityCandidate {
  status: CapabilityStatus;
}

export interface CapabilityResult {
  operationId: CoverageDomainOperationId;
  domain: CoverageDomain;
  status: CapabilityStatus;
  candidates: EvaluatedCapabilityCandidate[];
  evidenceKeys: string[];
  geographicQualification: RegionRelation;
  runtime: RuntimeStatus;
  policyState: "allowed" | "excluded" | "unknown";
  reasons: CoverageReasonCode[];
  optionalReasons: CoverageReasonCode[];
}

export interface OperationSummary {
  operationId: CoverageDomainOperationId;
  label?: string;
  status: CapabilityStatus;
  reasons: CoverageReasonCode[];
  evidenceKeys: string[];
  rights: RightsAssessmentSummary;
}

export interface RightsAssessmentSummary {
  status: RightsAssessmentStatus;
  reasons: CoverageReasonCode[];
  contributorKeys: string[];
  conditions: string[];
}

export interface CoverageRegion {
  key: RegionKey;
  label: string;
  kind: "extract" | "country" | "regional-scope" | "unassigned";
  originalId?: string;
  bounds?: Wgs84Bounds;
  aliases?: string[];
}

export interface RegionDomainSummary {
  domain: CoverageDomain;
  status: CapabilityStatus;
  operational: number;
  limited: number;
  unavailable: number;
  unknown: number;
  attention: number;
  reasons: CoverageReasonCode[];
}

export interface RegionMatrixRow {
  region: CoverageRegion;
  domains: Record<CoverageDomain, RegionDomainSummary>;
  sourceCount: number;
  attentionCount: number;
}

export interface CoverageSourceRow {
  count?: EvidenceCount;
  key: string;
  sourceId: string;
  name: string;
  owner: EvidenceOwner;
  domain: CoverageDomain;
  stream: string;
  enabled: boolean;
  active: boolean | null;
  region: StreamRegionEvidence;
  presence: EvidencePresence;
  freshness: FreshnessStatus;
  lastAttemptAt: string | null;
  lastSuccessfulCheckAt: string | null;
  lastPublishedAt: string | null;
  upstreamAsOf: string | null;
  expiresAt: string | null;
  latestAttempt: EvidenceAttempt;
  /** The next server-side freshness/expiry deadline, if one is known. */
  freshnessDeadline: string | null;
  rights: RightsAssessmentSummary;
  reasons: CoverageReasonCode[];
  correctiveLinks: Array<{ label: string; href: string }>;
}

export interface AuthorityObservation {
  authority: "data-manager" | "postgres" | "redis" | "integration-health" | "provider-health";
  status: AuthorityStatus;
  observedAt: string | null;
  errorCode?: string;
  message?: string;
}

export interface Pagination {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  snapshotId: string;
}

export interface CoverageReport {
  schemaVersion: 1;
  snapshotId: string;
  generatedAt: string;
  evaluatedAt: string;
  collectionStatus: CollectionStatus;
  collectionAgeSeconds: number;
  warnings: CoverageReasonCode[];
  authorities: AuthorityObservation[];
  region: CoverageRegion;
  summary: RegionDomainSummary[];
  capabilities: CapabilityResult[];
  operations: OperationSummary[];
  sources: CoverageSourceRow[];
  sourcePagination: Pagination;
  totalSourceCount: number;
  unassignedSourceCount: number;
  assessment: UsageAssessment;
  /** Earliest future deadline among the returned source rows. */
  nextDeadlineAt: string | null;
  policy: {
    effectiveSourcePolicy: "permissive" | "restricted" | "unknown";
    gatedSourceCount: number;
    gatedIntegrationCount: number;
  };
}

export interface CoverageRegionsResponse {
  schemaVersion: 1;
  snapshotId: string;
  generatedAt: string;
  evaluatedAt: string;
  collectionStatus: CollectionStatus;
  collectionAgeSeconds: number;
  warnings: CoverageReasonCode[];
  authorities: AuthorityObservation[];
  regions: RegionMatrixRow[];
  total: number;
  unassignedSourceCount: number;
  pagination: Pagination;
}

export interface CoverageSourceDetail {
  schemaVersion: 1;
  snapshotId: string;
  generatedAt: string;
  evaluatedAt: string;
  collectionStatus: CollectionStatus;
  source: CoverageSourceRow;
  evidence: StreamEvidence;
  runtime?: RuntimeEvidence;
  rights: RightsEvidence[];
  lineage: Array<{ fromKey: string; toKey: string; relation: string }>;
  recentAttempts: Array<EvidenceAttempt & { key: string }>;
  warnings: CoverageReasonCode[];
}

export const COVERAGE_DOMAINS: readonly CoverageDomain[] = [
  "addresses",
  "pois",
  "transit",
  "ev",
  "parking",
  "traffic",
];

export const COVERAGE_OPERATION_IDS: readonly CoverageDomainOperationId[] = [
  "addresses.forward-search",
  "addresses.reverse-geocoding",
  "pois.search",
  "pois.overture-enrichment",
  "transit.stop-search",
  "transit.departures",
  "transit.journey-planning",
  "transit.realtime",
  "ev.charger-discovery",
  "ev.charger-availability",
  "ev.route-planning",
  "parking.facility-discovery",
  "parking.occupancy",
  "traffic.flow",
  "traffic.road-conditions",
  "traffic.traffic-aware-routing",
];
