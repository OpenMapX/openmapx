import z from "zod/v4";
import type { CoverageDomain, CoverageReasonCode, StreamEvidence } from "./types";

const boundedString = (max = 512) => z.string().min(1).max(max);
const nullableDate = z.iso.datetime().nullable();
const date = z.iso.datetime();
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
const safeHttpUrl = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      if (url.username || url.password) return false;
      return ![...url.searchParams.keys()].some((key) =>
        credentialParameterNames.has(key.toLocaleLowerCase()),
      );
    } catch {
      return false;
    }
  }, "must be a credential-free HTTP(S) URL");

export const coverageDomainSchema = z.enum([
  "addresses",
  "pois",
  "transit",
  "ev",
  "parking",
  "traffic",
]);

export const coveragePermissionSchema = z.enum(["yes", "no", "conditional", "unknown"]);
export const evidencePresenceSchema = z.enum(["present", "empty", "not-configured", "unknown"]);
export const geographicEvidenceBasisSchema = z.enum([
  "declared",
  "published-region",
  "observed",
  "unknown",
]);
export const regionRelationSchema = z.enum([
  "exact",
  "contains",
  "intersects",
  "disjoint",
  "unknown",
]);
export const freshnessStatusSchema = z.enum([
  "current",
  "stale",
  "expired",
  "unknown",
  "not-applicable",
]);
export const attemptOutcomeSchema = z.enum([
  "running",
  "succeeded",
  "unchanged",
  "partial",
  "failed",
  "skipped",
  "unknown",
]);
export const runtimeStatusSchema = z.enum(["up", "degraded", "down", "unconfigured", "unknown"]);
export const capabilityStatusSchema = z.enum(["operational", "limited", "unavailable", "unknown"]);
export const rightsAssessmentStatusSchema = z.enum([
  "permitted",
  "conditions-apply",
  "not-permitted",
  "review-required",
  "not-applicable",
]);
export const coverageReasonCodeSchema = z.enum([
  "not_configured",
  "region_unknown",
  "declared_only",
  "no_publication_evidence",
  "upstream_check_failed",
  "publish_failed",
  "active_version_mismatch",
  "freshness_policy_missing",
  "live_expired",
  "schedule_validity_unknown",
  "collector_unavailable",
  "health_unobserved",
  "rights_unknown",
  "rights_conflict",
  "conditions_apply",
  "policy_excluded",
  "lineage_unknown",
  "clock_invalid",
  "source_disjoint",
  "source_partial",
  "runtime_down",
  "runtime_degraded",
  "binding_missing",
  "operation_unsupported",
  "optional_evidence_missing",
  "serving_earlier_data",
  "collector_timed_out",
  "schema_unavailable",
  "data_manager_unavailable",
  "evidence_truncated",
  "version_unverified",
  "source_not_active",
  "empty_observation",
]);

export const coverageOperationIdSchema = z.enum([
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
]);

const jobReferenceSchema = z.object({
  system: z.enum(["application", "data-manager"]),
  id: boundedString(256),
});

const evidenceOwnerSchema = z.object({
  kind: z.enum(["integration", "service"]),
  id: boundedString(256),
});

const boundsSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(
    ([west, south, east, north]) =>
      [west, south, east, north].every(Number.isFinite) &&
      west >= -180 &&
      west <= 180 &&
      east >= -180 &&
      east <= 180 &&
      south >= -90 &&
      south <= 90 &&
      north >= -90 &&
      north <= 90 &&
      south < north &&
      west !== east,
    "bounds must be valid WGS84 coordinates",
  );

const evidenceRegionSchema = z.object({
  keys: z.array(boundedString(256)).max(64),
  basis: geographicEvidenceBasisSchema,
  relation: regionRelationSchema,
  bounds: boundsSchema.optional(),
  label: boundedString(256).optional(),
});

const evidenceCountSchema = z.object({
  value: z.number().int().nonnegative().max(2_000_000_000),
  unit: boundedString(64),
  scope: boundedString(256),
});

const evidencePublicationSchema = z.object({
  version: z.string().max(512).nullable(),
  publishedAt: nullableDate,
  active: z.boolean().nullable(),
});

const evidenceAttemptSchema = z.object({
  at: nullableDate,
  outcome: attemptOutcomeSchema,
  job: jobReferenceSchema.optional(),
  reasonCode: coverageReasonCodeSchema.optional(),
  message: z.string().max(1_000).optional(),
});

const freshnessPolicySchema = z.object({
  basis: boundedString(128),
  expectedIntervalSeconds: z.number().int().positive().nullable().optional(),
  staleAt: nullableDate,
  expiresAt: nullableDate.optional(),
  version: boundedString(128),
  provenance: boundedString(512),
});

export const coverageRegionSchema = z
  .object({
    key: boundedString(256),
    label: boundedString(256),
    kind: z.enum(["extract", "country", "regional-scope", "unassigned"]),
    originalId: boundedString(256).optional(),
    bounds: boundsSchema.optional(),
    aliases: z.array(boundedString(256)).max(32).optional(),
  })
  .strict();

export const rightsEvidenceSchema = z
  .object({
    key: boundedString(512),
    qualifiedDatasetKey: boundedString(512),
    owner: evidenceOwnerSchema,
    sourceId: boundedString(256),
    name: boundedString(256).optional(),
    commercialUse: coveragePermissionSchema,
    redistribution: z
      .object({
        sourceData: coveragePermissionSchema,
        derivedData: coveragePermissionSchema,
      })
      .strict(),
    license: z.string().max(512).optional(),
    licenseUrl: safeHttpUrl.optional(),
    termsUrl: safeHttpUrl.optional(),
    attribution: z.string().max(1_000).optional(),
    usageConditions: z.array(z.string().min(1).max(1_000)).max(32),
    reviewedAt: z.union([z.iso.date(), z.iso.datetime()]).optional(),
    evidenceOrigin: z.string().max(512).optional(),
    conflict: z.boolean().optional(),
    lineageKnown: z.boolean(),
  })
  .strict();

export const authorityObservationSchema = z
  .object({
    authority: z.enum([
      "data-manager",
      "postgres",
      "redis",
      "integration-health",
      "provider-health",
    ]),
    status: z.enum(["available", "partial", "unavailable"]),
    observedAt: nullableDate,
    errorCode: boundedString(128).optional(),
    message: z.string().max(500).optional(),
  })
  .strict();

export const paginationSchema = z
  .object({
    offset: z.number().int().nonnegative().max(10_000_000),
    limit: z.number().int().positive().max(100),
    total: z.number().int().nonnegative().max(10_000_000),
    hasMore: z.boolean(),
    snapshotId: boundedString(128),
  })
  .strict();

const roadConditionOperationalMetricsSchema = z.object({
  status: boundedString(128),
  action: z.string().max(512).nullable(),
  changedCount: z.number().int().nonnegative().nullable(),
  rejectedCount: z.number().int().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative().nullable(),
  bindingCounts: z
    .record(z.string().max(64), z.number().int().nonnegative())
    .refine((value) => Object.keys(value).length <= 16, "Too many binding buckets")
    .nullable(),
  graph: z.object({
    generation: z.string().max(256).nullable(),
    status: z.enum(["ready", "partial", "missing", "unknown"]),
    regions: z.array(z.string().max(256)).max(64),
  }),
});

export const streamEvidenceSchema = z
  .object({
    key: boundedString(512),
    owner: evidenceOwnerSchema,
    sourceId: boundedString(256),
    attributionSourceId: boundedString(256).optional(),
    stream: boundedString(128),
    consumerInstance: boundedString(256).optional(),
    domain: coverageDomainSchema,
    observedAt: date,
    evidenceVersion: z.literal(1),
    presence: evidencePresenceSchema,
    region: evidenceRegionSchema,
    count: evidenceCountSchema.optional(),
    roadConditions: roadConditionOperationalMetricsSchema.optional(),
    publication: evidencePublicationSchema,
    attempt: evidenceAttemptSchema,
    lastSuccessfulCheckAt: nullableDate,
    lastSuccessfullyCheckedVersion: z.string().max(512).nullable(),
    upstreamAsOf: nullableDate,
    expiresAt: nullableDate,
    policy: freshnessPolicySchema,
    freshness: freshnessStatusSchema,
    reasons: z.array(coverageReasonCodeSchema).max(32),
  })
  .strict();

export const coverageEvidenceListSchema = z.array(streamEvidenceSchema).max(10_000);

/** The bounded internal data-manager page consumed by the API read model. */
export const dataManagerCoverageEvidencePageSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: boundedString(128),
    generatedAt: date,
    evaluatedAt: date,
    collectionStatus: z.enum(["complete", "partial", "unavailable"]),
    authorities: z.array(authorityObservationSchema).max(32),
    warnings: z.array(coverageReasonCodeSchema).max(32),
    regions: z.array(coverageRegionSchema).max(10_000),
    evidence: z.array(streamEvidenceSchema).max(100),
    rights: z.array(rightsEvidenceSchema).max(10_000).optional(),
    total: z.number().int().nonnegative().max(10_000_000),
    retainedTotal: z.number().int().nonnegative().max(10_000_000),
    truncated: z.boolean(),
    unassignedSourceCount: z.number().int().nonnegative().max(10_000_000),
    pagination: paginationSchema,
  })
  .strict();

export function parseStreamEvidence(value: unknown): StreamEvidence {
  return streamEvidenceSchema.parse(value) as StreamEvidence;
}

export type CoverageDomainFromSchema = CoverageDomain;
export type CoverageReasonCodeFromSchema = CoverageReasonCode;
