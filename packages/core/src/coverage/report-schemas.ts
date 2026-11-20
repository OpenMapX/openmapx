import { licensingSchema } from "@openmapx/extension-contracts/licensing-schema";
import z from "zod/v4";
import {
  attemptOutcomeSchema,
  authorityObservationSchema,
  capabilityStatusSchema,
  coverageDomainSchema,
  coverageOperationIdSchema,
  coveragePermissionSchema,
  coverageReasonCodeSchema,
  coverageRegionSchema,
  evidencePresenceSchema,
  freshnessStatusSchema,
  geographicEvidenceBasisSchema,
  paginationSchema,
  regionRelationSchema,
  rightsAssessmentStatusSchema,
  runtimeStatusSchema,
  streamEvidenceSchema,
} from "./schemas";

/*
 * Wire shapes of the administration coverage replies. They describe what the
 * API read model emits: every field is declared so the response serializer
 * keeps it, and unknown fields are refused rather than silently dropped.
 */

const timestamp = z.iso.datetime();
const nullableTimestamp = timestamp.nullable();
const reasons = z.array(coverageReasonCodeSchema);
const collectionStatusSchema = z.enum(["complete", "partial", "unavailable"]);
const usageAssessmentSchema = z.enum([
  "operational",
  "commercial",
  "redistribute-source-data",
  "redistribute-derived-data",
]);
const ownerSchema = z.strictObject({ kind: z.enum(["integration", "service"]), id: z.string() });
const countSchema = z.strictObject({ value: z.number(), unit: z.string(), scope: z.string() });
const attemptSchema = z.strictObject({
  at: nullableTimestamp,
  outcome: attemptOutcomeSchema,
  job: z
    .strictObject({ system: z.enum(["application", "data-manager"]), id: z.string() })
    .optional(),
  reasonCode: coverageReasonCodeSchema.optional(),
  message: z.string().optional(),
});
const regionEvidenceSchema = z.strictObject({
  keys: z.array(z.string()),
  basis: geographicEvidenceBasisSchema,
  relation: regionRelationSchema,
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).readonly().optional(),
  label: z.string().optional(),
});
const rightsSummarySchema = z.strictObject({
  status: rightsAssessmentStatusSchema,
  reasons,
  contributorKeys: z.array(z.string()),
  conditions: z.array(z.string()),
});
const regionDomainSummarySchema = z.strictObject({
  domain: coverageDomainSchema,
  status: capabilityStatusSchema,
  operational: z.number(),
  limited: z.number(),
  unavailable: z.number(),
  unknown: z.number(),
  attention: z.number(),
  reasons,
});
const candidateSchema = z.strictObject({
  id: z.string(),
  providerId: z.string(),
  label: z.string().optional(),
  enabled: z.boolean(),
  operationSupported: z.union([z.boolean(), z.literal("unknown")]),
  binding: z.enum(["resolved", "not-required", "missing", "unknown"]),
  runtime: runtimeStatusSchema,
  presence: evidencePresenceSchema,
  regionRelation: regionRelationSchema,
  freshness: freshnessStatusSchema,
  freshnessUsable: z.boolean(),
  requiredEvidenceKeys: z.array(z.string()),
  optionalEvidenceKeys: z.array(z.string()).optional(),
  reasons,
  optionalReasons: reasons.optional(),
  status: capabilityStatusSchema,
});
const capabilitySchema = z.strictObject({
  operationId: coverageOperationIdSchema,
  domain: coverageDomainSchema,
  status: capabilityStatusSchema,
  candidates: z.array(candidateSchema),
  evidenceKeys: z.array(z.string()),
  geographicQualification: regionRelationSchema,
  runtime: runtimeStatusSchema,
  policyState: z.enum(["allowed", "excluded", "unknown"]),
  reasons,
  optionalReasons: reasons,
});
const operationSummarySchema = z.strictObject({
  operationId: coverageOperationIdSchema,
  label: z.string().optional(),
  status: capabilityStatusSchema,
  reasons,
  evidenceKeys: z.array(z.string()),
  rights: rightsSummarySchema,
});
export const coverageSourceRowSchema = z.strictObject({
  count: countSchema.optional(),
  key: z.string(),
  sourceId: z.string(),
  name: z.string(),
  owner: ownerSchema,
  domain: coverageDomainSchema,
  stream: z.string(),
  enabled: z.boolean(),
  active: z.boolean().nullable(),
  region: regionEvidenceSchema,
  presence: evidencePresenceSchema,
  freshness: freshnessStatusSchema,
  lastAttemptAt: nullableTimestamp,
  lastSuccessfulCheckAt: nullableTimestamp,
  lastPublishedAt: nullableTimestamp,
  upstreamAsOf: nullableTimestamp,
  expiresAt: nullableTimestamp,
  latestAttempt: attemptSchema,
  freshnessDeadline: nullableTimestamp,
  rights: rightsSummarySchema,
  reasons,
  correctiveLinks: z.array(z.strictObject({ label: z.string(), href: z.string() })),
});
const snapshotFields = {
  schemaVersion: z.literal(1),
  snapshotId: z.string(),
  generatedAt: timestamp,
  evaluatedAt: timestamp,
  collectionStatus: collectionStatusSchema,
};

export const coverageReportSchema = z.strictObject({
  ...snapshotFields,
  collectionAgeSeconds: z.number(),
  warnings: reasons,
  authorities: z.array(authorityObservationSchema),
  region: coverageRegionSchema,
  summary: z.array(regionDomainSummarySchema),
  capabilities: z.array(capabilitySchema),
  operations: z.array(operationSummarySchema),
  sources: z.array(coverageSourceRowSchema),
  sourcePagination: paginationSchema,
  totalSourceCount: z.number(),
  unassignedSourceCount: z.number(),
  assessment: usageAssessmentSchema,
  nextDeadlineAt: nullableTimestamp,
  policy: z.strictObject({
    effectiveSourcePolicy: z.enum(["permissive", "restricted", "unknown"]),
    gatedSourceCount: z.number(),
    gatedIntegrationCount: z.number(),
  }),
});

export const coverageRegionsResponseSchema = z.strictObject({
  ...snapshotFields,
  collectionAgeSeconds: z.number(),
  warnings: reasons,
  authorities: z.array(authorityObservationSchema),
  regions: z.array(
    z.strictObject({
      region: coverageRegionSchema,
      domains: z.strictObject({
        addresses: regionDomainSummarySchema,
        pois: regionDomainSummarySchema,
        transit: regionDomainSummarySchema,
        ev: regionDomainSummarySchema,
        parking: regionDomainSummarySchema,
        fuel: regionDomainSummarySchema,
        cameras: regionDomainSummarySchema,
        traffic: regionDomainSummarySchema,
      }),
      sourceCount: z.number(),
      attentionCount: z.number(),
    }),
  ),
  total: z.number(),
  unassignedSourceCount: z.number(),
  pagination: paginationSchema,
});

export const coverageSourceDetailSchema = z.strictObject({
  ...snapshotFields,
  collectionAgeSeconds: z.number(),
  authorities: z.array(authorityObservationSchema),
  source: coverageSourceRowSchema,
  evidence: streamEvidenceSchema,
  runtime: z
    .strictObject({
      key: z.string(),
      owner: ownerSchema,
      providerId: z.string(),
      status: runtimeStatusSchema,
      observedAt: nullableTimestamp,
      validUntil: nullableTimestamp,
      policy: z.strictObject({
        basis: z.string(),
        maxAgeSeconds: z.number().nullable(),
        version: z.string(),
        provenance: z.string(),
      }),
      reason: coverageReasonCodeSchema.optional(),
      message: z.string().optional(),
    })
    .optional(),
  rights: z.array(
    z.strictObject({
      key: z.string(),
      qualifiedDatasetKey: z.string(),
      owner: ownerSchema,
      sourceId: z.string(),
      name: z.string().optional(),
      commercialUse: coveragePermissionSchema,
      redistribution: z.strictObject({
        sourceData: coveragePermissionSchema,
        derivedData: coveragePermissionSchema,
      }),
      licensing: licensingSchema.optional(),
      termsUrl: z.string().optional(),
      attribution: z.string().optional(),
      usageConditions: z.array(z.string()),
      reviewedAt: z.string().optional(),
      evidenceOrigin: z.string().optional(),
      conflict: z.boolean().optional(),
      lineageKnown: z.boolean(),
    }),
  ),
  lineage: z.array(
    z.strictObject({ fromKey: z.string(), toKey: z.string(), relation: z.string() }),
  ),
  recentAttempts: z.array(attemptSchema.extend({ key: z.string() })),
  warnings: reasons,
});
