import {
  catalogProposalInputSchema,
  catalogProposalSchema,
  catalogProposalSummarySchema,
} from "../catalog-pins/proposal-schemas";
import { catalogRuntimeInputsSchema } from "../catalog-pins/review-schemas";
import { catalogPinSetSchema } from "../catalog-pins/schemas";
import { platformConfigurationSchema } from "../services/platform-configuration";
import {
  configurationGenerationRevisionSchema,
  configurationHardlinksApplyOperationSchema,
  integrationConfigApplyOperationSchema,
  serviceConfigApplyOperationSchema,
  serviceIdSchema,
  serviceRecreateIsolatedOperationSchema,
  serviceRecreateOperationSchema,
  serviceSelectionApplyOperationSchema,
  stableIdSchema,
  stackRenderOperationSchema,
  vaultApplyOperationSchema,
} from "./configuration-operation-records";
import { dataWorkflowReceiptSchema } from "./job-evidence";

export { configurationGenerationRevisionSchema } from "./configuration-operation-records";

import z from "zod/v4";
import {
  pairedPinApprovalInputSchema,
  pairedPinApprovalResultSchema,
} from "./catalog-pin-approval";
import {
  configurationMaintenanceDecisionSchema,
  configurationMaintenancePrepareSchema,
  configurationMaintenanceReceiptSchema,
  configurationMaintenanceSettleSchema,
} from "./configuration-maintenance";
import {
  configurationHardlinksPreviewSchema,
  configurationSourcesInspectionSchema,
  coordinatorModeSchema,
} from "./configuration-preparation-records";
import { opsFailureResultSchema, processDiagnosticsSchema } from "./job-evidence";
import {
  type HistoricalServicePullResult,
  historicalServicePullResultSchema,
  servicePullOperationSchema,
  servicePullResultSchema,
} from "./service-operation-records";
import { hardlinkApplySummarySchema, serviceActionsSchema } from "./service-results";

export const OPS_PROTOCOL_VERSION = 2 as const;
export const OPS_MAX_LOG_TAIL = 1_000;
export const OPS_MAX_EVENT_MESSAGE_BYTES = 4_096;
export const OPS_MAX_EVENT_BATCH = 100;
export const OPS_MAX_FOLLOW_LOG_EVENTS = 2_000;
export const OPS_MAX_RESULT_BYTES = 1024 * 1024;
export const OPS_MAX_HTTP_RESPONSE_BYTES = OPS_MAX_RESULT_BYTES + 32 * 1024;
export const OPS_MAX_REQUEST_TTL_MS = 30_000;
export const OPS_MAX_CLOCK_SKEW_MS = 5_000;
export const OPS_MAX_BACKUP_ID_LENGTH = 128;
export const OPS_MAX_BACKUP_INVENTORY_ENTRIES = 128;

export const OPS_OPERATION_KINDS = [
  "controlRetention.acknowledge",
  "docker.status",
  "stack.status",
  "services.inspect",
  "stack.render",
  "configuration.inspect",
  "configuration.hardlinks.inspect",
  "configuration.sources.inspect",
  "configuration.hardlinks.preview",
  "configuration.hardlinks.apply",
  "configurationMaintenance.prepare",
  "configurationMaintenance.inspect",
  "configurationMaintenance.decide",
  "configurationMaintenance.settle",
  "stack.start",
  "stack.stop",
  "service.start",
  "service.stop",
  "service.restart",
  "coreService.restart",
  "service.recreate",
  "service.recreateIsolated",
  "service.pull",
  "service.remove",
  "service.update",
  "service.build",
  "services.buildAll",
  "service.logs",
  "service.logs.follow",
  "dawarich.provisioning.inspect",
  "release.resolve",
  "release.pull",
  "release.inspect",
  "release.apply",
  "appApi.replace",
  "appApi.runtime.inspect",
  "agent.update",
  "agent.handoff.inspect",
  "backup.list",
  "backup.create",
  "backup.restore",
  "backup.delete",
  "system.diagnostics",
  "system.inspect",
  "system.update",
  "serviceRepository.inspect",
  "serviceRepository.publish",
  "serviceRepository.settle",
  "serviceRepository.remove",
  "communityServices.inspect",
  "serviceSelection.apply",
  "serviceSelection.inspect",
  "serviceConfig.apply",
  "integrationConfig.apply",
  "vault.apply",
  "data.inspect",
  "data.downloadOsm",
  "data.downloadFonts",
  "data.update",
  "data.convertOverpass",
  "data.link",
  "data.clean",
  "data.generateApiKeys",
  "data.overtureSync",
  "data.overtureConflate",
  "data.searchIndexBuild",
  "data.notablePlacesBuild",
  "motis.staging.restart",
  "motis.staging.stop",
  "motis.primary.restart",
  "motis.primary.stop",
  "motis.primary.promote",
  "feedProxy.validateAndReload",
  "valhalla.traffic.disable",
  "valhalla.traffic.inspect",
  "valhalla.traffic.maintain",
  "valhalla.traffic.refreshWaysToEdges",
  "postgis.capacity.inspect",
  "catalogPins.inspect",
  "transitCredentials.inspect",
  "transitousLock.inspect",
  "transitousLock.propose",
  "transitousLock.approve",
  "gbfsCatalogLock.inspect",
] as const;

export type OpsOperationKind = (typeof OPS_OPERATION_KINDS)[number];

/** `none` means no handoff with the requested ID exists. */
export const OPS_AGENT_HANDOFF_PHASES = [
  "none",
  "launched",
  "overlay_written",
  "recreated",
  "applied",
  "rolled_back",
  "failed",
] as const;
export type OpsAgentHandoffPhase = (typeof OPS_AGENT_HANDOFF_PHASES)[number];
export type OpsRole = "api" | "data-manager";
export type OpsExecutionMode = "sync" | "async";

export interface OpsKindPolicy {
  role: OpsRole;
  execution: OpsExecutionMode;
  timeoutMs: number;
  maxResultBytes: number;
  emitsEvents: boolean;
}

const sync = (role: OpsRole, timeoutMs: number, maxResultBytes = 64 * 1024): OpsKindPolicy => ({
  role,
  execution: "sync",
  timeoutMs,
  maxResultBytes,
  emitsEvents: false,
});
const asyncEffect = (
  role: OpsRole,
  timeoutMs: number,
  maxResultBytes = 64 * 1024,
  emitsEvents = true,
): OpsKindPolicy => ({ role, execution: "async", timeoutMs, maxResultBytes, emitsEvents });

// Leave settlement time after the whole lifecycle command deadline.
const LIFECYCLE_TIMEOUT_MS = 10 * 60_000 + 30_000;

export const OPS_KIND_POLICIES = {
  "controlRetention.acknowledge": sync("api", 15_000),
  "docker.status": sync("api", 5_000),
  "stack.status": sync("api", 15_000, 256 * 1024),
  "services.inspect": sync("api", 15_000, 512 * 1024),
  "configuration.inspect": sync("api", 15_000),
  "configuration.hardlinks.inspect": sync("api", 15_000, 1024 * 1024),
  "configuration.sources.inspect": sync("api", 15_000, 128 * 1024),
  "configuration.hardlinks.preview": sync("api", 15_000, 32 * 1024),
  "configuration.hardlinks.apply": asyncEffect("api", 10 * 60_000),
  "configurationMaintenance.prepare": asyncEffect("api", 3600_000, 65536),
  "configurationMaintenance.inspect": sync("api", 15_000, 65536),
  "configurationMaintenance.decide": asyncEffect("api", 60_000, 65536),
  "configurationMaintenance.settle": asyncEffect("api", 60_000, 65536),
  "stack.render": asyncEffect("api", 120_000),
  "stack.start": asyncEffect("api", LIFECYCLE_TIMEOUT_MS),
  "stack.stop": asyncEffect("api", 5 * 60_000),
  "service.start": asyncEffect("api", LIFECYCLE_TIMEOUT_MS),
  "service.stop": asyncEffect("api", LIFECYCLE_TIMEOUT_MS),
  "service.restart": asyncEffect("api", LIFECYCLE_TIMEOUT_MS),
  "coreService.restart": asyncEffect("api", LIFECYCLE_TIMEOUT_MS),
  "service.recreate": asyncEffect("api", LIFECYCLE_TIMEOUT_MS),
  "service.recreateIsolated": asyncEffect("api", LIFECYCLE_TIMEOUT_MS),
  "service.pull": asyncEffect("api", 15 * 60_000),
  "service.remove": asyncEffect("api", LIFECYCLE_TIMEOUT_MS),
  "service.update": asyncEffect("api", 15 * 60_000),
  "service.build": asyncEffect("api", 12 * 3600_000),
  "services.buildAll": asyncEffect("api", 24 * 3600_000, 64 * 1024),
  "service.logs": sync("api", 30_000, 1024 * 1024),
  "service.logs.follow": asyncEffect("api", 15 * 60_000, 64 * 1024),
  "dawarich.provisioning.inspect": sync("api", 30_000),
  "release.resolve": asyncEffect("api", 2 * 60_000),
  "release.pull": asyncEffect("api", 15 * 60_000),
  "release.inspect": sync("api", 30_000, 256 * 1024),
  "release.apply": asyncEffect("api", 30 * 60_000),
  "appApi.replace": asyncEffect("api", 10 * 60_000),
  "appApi.runtime.inspect": sync("api", 30_000),
  "agent.update": asyncEffect("api", 2 * 60_000),
  "agent.handoff.inspect": sync("api", 30_000),
  "backup.list": sync("api", 30_000, 256 * 1024),
  "backup.create": asyncEffect("api", 30 * 60_000),
  "backup.restore": asyncEffect("api", 30 * 60_000),
  "backup.delete": asyncEffect("api", 5 * 60_000),
  "system.diagnostics": asyncEffect("api", 10 * 60_000, 256 * 1024),
  "system.inspect": sync("api", 30_000, 256 * 1024),
  "system.update": asyncEffect("api", 48 * 3600_000),
  "serviceRepository.inspect": asyncEffect("api", 5 * 60_000, 1024 * 1024),
  "serviceRepository.publish": asyncEffect("api", 10 * 60_000),
  "serviceRepository.settle": asyncEffect("api", 5 * 60_000),
  "serviceRepository.remove": asyncEffect("api", 5 * 60_000),
  "communityServices.inspect": sync("api", 15_000, 1024 * 1024),
  "serviceSelection.apply": asyncEffect("api", 2 * 60_000),
  "serviceSelection.inspect": sync("api", 15_000),
  "serviceConfig.apply": asyncEffect("api", 2 * 60_000),
  "integrationConfig.apply": asyncEffect("api", 2 * 60_000),
  "vault.apply": asyncEffect("api", 2 * 60_000),
  "data.inspect": sync("api", 30_000, 256 * 1024),
  "data.downloadOsm": asyncEffect("api", 24 * 3600_000),
  "data.downloadFonts": asyncEffect("api", 24 * 3600_000),
  "data.update": asyncEffect("api", 24 * 3600_000),
  "data.convertOverpass": asyncEffect("api", 24 * 3600_000),
  "data.link": asyncEffect("api", 10 * 60_000),
  "data.clean": asyncEffect("api", 10 * 60_000),
  "data.generateApiKeys": asyncEffect("api", 10 * 60_000),
  "data.overtureSync": asyncEffect("api", 24 * 3600_000),
  "data.overtureConflate": asyncEffect("api", 24 * 3600_000),
  "data.searchIndexBuild": asyncEffect("api", 24 * 3600_000),
  "data.notablePlacesBuild": asyncEffect("api", 24 * 3600_000),
  "motis.staging.restart": asyncEffect("data-manager", 2 * 60_000),
  "motis.staging.stop": asyncEffect("data-manager", 2 * 60_000),
  "motis.primary.restart": asyncEffect("data-manager", 2 * 60_000),
  "motis.primary.stop": asyncEffect("data-manager", 2 * 60_000),
  "motis.primary.promote": asyncEffect("data-manager", 10 * 60_000),
  "feedProxy.validateAndReload": asyncEffect("data-manager", 2 * 60_000),
  "valhalla.traffic.disable": sync("data-manager", 20_000),
  "valhalla.traffic.inspect": sync("data-manager", 30_000),
  "valhalla.traffic.maintain": asyncEffect("data-manager", 30 * 60_000),
  "valhalla.traffic.refreshWaysToEdges": asyncEffect("data-manager", 30 * 60_000),
  "postgis.capacity.inspect": sync("data-manager", 30_000),
  "transitCredentials.inspect": sync("api", 120_000, 768 * 1024),
  "catalogPins.inspect": sync("api", 30_000, 768 * 1024),
  "transitousLock.inspect": sync("data-manager", 30_000, 768 * 1024),
  "transitousLock.propose": sync("data-manager", 30_000),
  "transitousLock.approve": asyncEffect("data-manager", 120_000, 4096),
  "gbfsCatalogLock.inspect": sync("data-manager", 30_000),
} as const satisfies Record<OpsOperationKind, OpsKindPolicy>;

/** Read streams/diagnostics do not acquire control-root authority or a retention dependency. */
export function opsKindRequiresControlAuthority(kind: OpsOperationKind): boolean {
  return (
    OPS_KIND_POLICIES[kind].execution === "async" &&
    !["service.logs.follow", "system.diagnostics", "serviceRepository.inspect"].includes(kind)
  );
}
const operationKindSchema = z.enum(OPS_OPERATION_KINDS);
const backupIdSchema = z
  .string()
  .min(1)
  .max(OPS_MAX_BACKUP_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const regionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/);
const resourceIdSchema = z.union([stableIdSchema, regionIdSchema]);
const countryCodeSchema = z.string().regex(/^[A-Z]{2,3}$/);
const requestIdSchema = z.string().regex(/^ops1_[A-Za-z0-9_-]{16,64}$/);
const operationKeySchema = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/);
const operationIdSchema = z.string().regex(/^job1_[A-Za-z0-9_-]{16,64}$/);
const timestampSchema = z.string().datetime({ offset: true });

// `<branch>@<40-hex commit>`. An abbreviated SHA is ambiguous and a symbolic
// ref is mutable, so neither identifies exactly one reviewed commit.
const transitousRefSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*@[0-9a-f]{40}$/);
const transitousSubmodulesSchema = z.record(
  z.string().min(1).max(256),
  z.string().regex(/^[0-9a-f]{40}$/),
);
const actorLabelSchema = z.string().min(1).max(128);

// Community service repositories. The ops-agent owns their checkouts under
// `services/.community/<repository>`, where the repository id is the first 16
// hex digits of the SHA-256 of the canonical URL.
const repositoryIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
// The canonical form of an allowed Git URL: https on the default port, without
// credentials, query or fragment. The agent checks the host allowlist again
// before it fetches anything.
const gitRepositoryUrlSchema = z
  .string()
  .max(2_048)
  .regex(/^https:\/\/[a-z0-9.-]+\/[^\s?#]+$/);
const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const repositoryTransactionIdSchema = z.string().regex(/^txn1_[a-f0-9]{24}$/);
const serviceIdListSchema = z.array(serviceIdSchema).max(256);
// What the API needs to undo an interrupted extension change, kept by the agent
// with the pending repository transaction so it survives an API restart.
const repositoryRecoverySchema = z.strictObject({
  selectionBefore: serviceIdListSchema.nullable(),
  touchedServiceIds: serviceIdListSchema,
  previouslyEnabledServiceIds: serviceIdListSchema,
});
// A service manifest as read from a checkout. Its receiver validates it with
// the service manifest rules; the result size limit bounds it here.
const serviceManifestObjectSchema = z.record(z.string().max(256), z.unknown());
const transitousLockRecordSchema = z.strictObject({
  ref: transitousRefSchema,
  submodules: transitousSubmodulesSchema,
  lockedAt: timestampSchema,
  lockedBy: actorLabelSchema,
  comment: z.string().max(512).optional(),
});

const kindOnly = <T extends OpsOperationKind>(kind: T) => z.strictObject({ kind: z.literal(kind) });
const serviceOperation = <T extends OpsOperationKind>(kind: T) =>
  z.strictObject({ kind: z.literal(kind), serviceId: serviceIdSchema });

export const opsOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("controlRetention.acknowledge"),
    originRootKey: operationKeySchema,
    operationKey: operationKeySchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    terminalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    proof: z.string().min(1).max(4096),
  }),
  kindOnly("docker.status"),
  kindOnly("stack.status"),
  kindOnly("services.inspect"),
  kindOnly("configuration.inspect"),
  kindOnly("configuration.sources.inspect"),
  configurationMaintenancePrepareSchema,
  z.strictObject({
    kind: z.literal("configurationMaintenance.inspect"),
    maintenanceId: z.uuid(),
    candidateId: z.uuid(),
  }),
  configurationMaintenanceDecisionSchema,
  configurationMaintenanceSettleSchema,
  z.strictObject({
    kind: z.literal("configuration.hardlinks.preview"),
    candidateId: z.uuid(),
    revisionId: configurationGenerationRevisionSchema,
    expectedCurrentRevisionId: configurationGenerationRevisionSchema.nullable(),
    expectedSourceRevision: z.uuid(),
    coordinatorMode: coordinatorModeSchema,
  }),
  configurationHardlinksApplyOperationSchema,
  stackRenderOperationSchema,
  // The hardlink plan of the named, applied configuration generation. Fails if
  // another generation has been applied since. Data-manager applies it: only
  // its mounts confine the links and prunes to the data root.
  z.strictObject({
    kind: z.literal("configuration.hardlinks.inspect"),
    revisionId: configurationGenerationRevisionSchema,
  }),
  z.strictObject({
    kind: z.literal("stack.start"),
    expectedConfigurationRevisionId: configurationGenerationRevisionSchema,
  }),
  kindOnly("stack.stop"),
  z.strictObject({
    kind: z.literal("service.start"),
    serviceId: serviceIdSchema,
    expectedConfigurationRevisionId: configurationGenerationRevisionSchema,
  }),
  serviceOperation("service.stop"),
  serviceOperation("service.restart"),
  z.strictObject({
    kind: z.literal("coreService.restart"),
    serviceId: z.enum(["app-api", "traefik"]),
    expectedConfigurationRevisionId: configurationGenerationRevisionSchema,
  }),
  serviceRecreateOperationSchema,
  serviceRecreateIsolatedOperationSchema,
  servicePullOperationSchema,
  serviceOperation("service.remove"),
  z.strictObject({
    kind: z.literal("service.update"),
    serviceId: serviceIdSchema,
    expectedConfigurationRevisionId: configurationGenerationRevisionSchema,
    noDeps: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("service.build"),
    serviceId: serviceIdSchema,
    regionId: regionIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("services.buildAll"),
    regionId: regionIdSchema.optional(),
    failFast: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("service.logs"),
    serviceId: serviceIdSchema,
    tail: z.number().int().min(1).max(OPS_MAX_LOG_TAIL),
  }),
  z.strictObject({
    kind: z.literal("service.logs.follow"),
    serviceId: serviceIdSchema,
    tail: z.number().int().min(1).max(OPS_MAX_LOG_TAIL),
    maxDurationSeconds: z.number().int().min(1).max(900),
  }),
  kindOnly("dawarich.provisioning.inspect"),
  kindOnly("release.resolve"),
  z.strictObject({ kind: z.literal("release.pull"), releaseId: stableIdSchema }),
  kindOnly("release.inspect"),
  z.strictObject({ kind: z.literal("release.apply"), releaseId: stableIdSchema }),
  z.strictObject({
    kind: z.literal("appApi.replace"),
    releaseId: stableIdSchema,
    updateJobId: stableIdSchema,
  }),
  kindOnly("appApi.runtime.inspect"),
  z.strictObject({
    kind: z.literal("agent.update"),
    releaseId: stableIdSchema,
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    handoffId: stableIdSchema,
  }),
  z.strictObject({ kind: z.literal("agent.handoff.inspect"), handoffId: stableIdSchema }),
  kindOnly("backup.list"),
  z.strictObject({ kind: z.literal("backup.create"), backupId: backupIdSchema }),
  z.strictObject({
    kind: z.literal("backup.restore"),
    backupId: backupIdSchema,
    serviceIds: z.array(serviceIdSchema).max(64).optional(),
    stopRunning: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("backup.delete"), backupId: backupIdSchema }),
  kindOnly("system.diagnostics"),
  kindOnly("system.inspect"),
  z.strictObject({
    kind: z.literal("system.update"),
    releaseId: stableIdSchema,
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createBackup: z.boolean(),
    backupId: backupIdSchema.optional(),
  }),
  // Clones a repository into staging, validates its services and discards the
  // clone. Validation problems are part of the result, not a failure.
  z.strictObject({
    kind: z.literal("serviceRepository.inspect"),
    url: gitRepositoryUrlSchema,
    ref: gitRefSchema.optional(),
  }),
  // Installs the exact commit as the repository's checkout. The previous
  // checkout is kept until the transaction is settled.
  z.strictObject({
    kind: z.literal("serviceRepository.publish"),
    url: gitRepositoryUrlSchema,
    commit: gitCommitSchema,
    // The ref the commit was inspected at, for hosts that refuse to fetch an
    // unadvertised commit; it must still resolve to `commit`.
    ref: gitRefSchema.optional(),
    extensionId: serviceIdSchema,
    recovery: repositoryRecoverySchema,
  }),
  z.strictObject({
    kind: z.literal("serviceRepository.settle"),
    repository: repositoryIdSchema,
    transactionId: repositoryTransactionIdSchema,
    // `rollback` restores the previous checkout and keeps the recovery note;
    // `release` drops the note once the API has restored what it describes.
    outcome: z.enum(["commit", "rollback", "release"]),
  }),
  z.strictObject({
    kind: z.literal("serviceRepository.remove"),
    repository: repositoryIdSchema,
    extensionId: serviceIdSchema,
  }),
  kindOnly("communityServices.inspect"),
  serviceSelectionApplyOperationSchema,
  kindOnly("serviceSelection.inspect"),
  serviceConfigApplyOperationSchema,
  integrationConfigApplyOperationSchema,
  vaultApplyOperationSchema,
  kindOnly("data.inspect"),
  z.strictObject({ kind: z.literal("data.downloadOsm"), regionId: regionIdSchema.optional() }),
  kindOnly("data.downloadFonts"),
  z.strictObject({
    kind: z.literal("data.update"),
    regionId: regionIdSchema.optional(),
    countryCodes: z.array(countryCodeSchema).max(64).optional(),
    failFast: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("data.convertOverpass"), regionId: regionIdSchema.optional() }),
  kindOnly("data.link"),
  z.strictObject({ kind: z.literal("data.clean"), dataTypeId: stableIdSchema }),
  z.strictObject({ kind: z.literal("data.generateApiKeys"), catalogRevisionId: stableIdSchema }),
  z.strictObject({ kind: z.literal("data.overtureSync"), regionId: regionIdSchema }),
  z.strictObject({
    kind: z.literal("data.overtureConflate"),
    regionId: regionIdSchema,
    restart: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal("data.searchIndexBuild"), regionId: regionIdSchema }),
  kindOnly("data.notablePlacesBuild"),
  kindOnly("motis.staging.restart"),
  kindOnly("motis.staging.stop"),
  kindOnly("motis.primary.restart"),
  kindOnly("motis.primary.stop"),
  z.strictObject({ kind: z.literal("motis.primary.promote"), preparedRunId: stableIdSchema }),
  z.strictObject({ kind: z.literal("feedProxy.validateAndReload"), candidateId: stableIdSchema }),
  kindOnly("valhalla.traffic.disable"),
  kindOnly("valhalla.traffic.inspect"),
  z.strictObject({
    kind: z.literal("valhalla.traffic.maintain"),
    plan: z.enum(["rebuild-extract", "apply-predicted-and-rebuild"]),
    preparedGeneration: z.uuid().optional(),
  }),
  kindOnly("valhalla.traffic.refreshWaysToEdges"),
  kindOnly("postgis.capacity.inspect"),
  // The catalog lock lives under the repository's `infra/docker/`, which only
  // the operations agent may write. Callers name a pinned ref, never a path.
  kindOnly("catalogPins.inspect"),
  z.strictObject({
    kind: z.literal("transitCredentials.inspect"),
    proposalId: z.uuid().optional(),
    catalogRevisionId: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    kind: z.literal("transitousLock.inspect"),
    proposalId: z.uuid().optional(),
    offset: z.number().int().min(0).max(4096).optional(),
  }),
  z.strictObject({
    kind: z.literal("transitousLock.propose"),
    ...catalogProposalInputSchema.shape,
  }),
  pairedPinApprovalInputSchema,
  kindOnly("gbfsCatalogLock.inspect"),
]);
export type OpsOperation = z.infer<typeof opsOperationSchema>;
export type TrustedConfigurationApplyOperation = Extract<
  OpsOperation,
  {
    kind:
      | "stack.render"
      | "serviceSelection.apply"
      | "serviceConfig.apply"
      | "integrationConfig.apply"
      | "vault.apply";
  }
>;
export function isTrustedConfigurationApplyOperation(
  operation: OpsOperation,
): operation is TrustedConfigurationApplyOperation {
  return [
    "stack.render",
    "serviceSelection.apply",
    "serviceConfig.apply",
    "integrationConfig.apply",
    "vault.apply",
  ].includes(operation.kind);
}

const opsRequestSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(OPS_PROTOCOL_VERSION)]),
    requestId: requestIdSchema,
    operationKey: operationKeySchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    operation: opsOperationSchema,
    execution: z
      .strictObject({ requestedDeadlineAt: z.number().int().nonnegative().safe() })
      .optional(),
  })
  .refine(
    (request) => request.version === 2 || request.execution === undefined,
    "Version1 cannot carry execution authority",
  );
export type OpsRequest = z.infer<typeof opsRequestSchema>;

export function authorizeOpsOperation(role: OpsRole, kind: OpsOperationKind): boolean {
  // Decode retained historical records, but never admit a new remote file writer.
  if (kind === "data.generateApiKeys") return false;
  return (
    OPS_KIND_POLICIES[kind].role === role ||
    (role === "data-manager" && kind === "catalogPins.inspect")
  );
}

export type OpsErrorClass =
  | "authentication"
  | "authorization"
  | "validation"
  | "replay"
  | "stale"
  | "future"
  | "timeout"
  | "busy"
  | "conflict"
  | "not_found"
  | "not_wired"
  | "control_upgrade_required"
  | "recovery_required"
  | "host_update_required"
  | "configuration_prerequisite"
  | "runtime";
export const OPS_PUBLIC_ERROR_MESSAGES: Record<OpsErrorClass, string> = {
  authentication: "Request authentication failed",
  authorization: "Operation is not permitted",
  validation: "Request validation failed",
  replay: "Request was already used",
  stale: "Request has expired",
  future: "Request timestamp is invalid",
  timeout: "Operation timed out",
  busy: "Operations service is busy",
  conflict: "Operation key conflicts with an existing operation",
  configuration_prerequisite:
    "Apply or update Data Manager before changing instance configuration.",
  not_found: "Operation was not found",
  not_wired: "Operation is not available",
  control_upgrade_required:
    "Update the API or CLI client to persist a timed control root before submitting this mutation.",
  recovery_required: "Operation requires an explicit retry",
  host_update_required:
    "Host update required: the operations agent or its backup helper could not be updated from the admin panel. Run `pnpm openmapx compose release`, then `pnpm openmapx services update app-api app-web data-manager ops-agent transitous-runner` on the host.",
  runtime: "Operation failed",
};
export class OpsContractError extends Error {
  constructor(
    readonly errorClass: Extract<OpsErrorClass, "authorization" | "validation">,
    message: string,
  ) {
    super(message);
    this.name = "OpsContractError";
  }
}

export function parseOpsRequest(input: unknown, options: { role: OpsRole }): OpsRequest {
  const rawOperation =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as { operation?: unknown }).operation
      : undefined;
  const rawKind =
    rawOperation && typeof rawOperation === "object" && !Array.isArray(rawOperation)
      ? (rawOperation as { kind?: unknown }).kind
      : undefined;
  const recognizedKind = operationKindSchema.safeParse(rawKind);
  if (recognizedKind.success && !authorizeOpsOperation(options.role, recognizedKind.data))
    throw new OpsContractError("authorization", "Operation is not permitted for this role");
  const parsed = opsRequestSchema.safeParse(input);
  if (!parsed.success) throw new OpsContractError("validation", "Invalid operations request");
  if (
    parsed.data.operation.kind === "system.update" &&
    ((parsed.data.operation.createBackup && parsed.data.operation.backupId === undefined) ||
      (!parsed.data.operation.createBackup && parsed.data.operation.backupId !== undefined))
  ) {
    throw new OpsContractError("validation", "Invalid operations request");
  }
  return parsed.data;
}

type PolicyResult = boolean | Promise<boolean>;
export interface OpsResourcePolicy {
  allowGlobal?: (kind: OpsOperationKind) => PolicyResult;
  allowService?: (kind: OpsOperationKind, serviceId: string) => PolicyResult;
  allowBackup?: (
    kind: "backup.create" | "backup.restore" | "backup.delete",
    backupId: string,
    serviceIds?: readonly string[],
  ) => PolicyResult;
  allowPreparedRun?: (preparedRunId: string) => PolicyResult;
  allowCandidate?: (candidateId: string) => PolicyResult;
  allowRelease?: (
    kind: "release.pull" | "release.apply" | "appApi.replace" | "agent.update" | "system.update",
    releaseId: string,
  ) => PolicyResult;
  allowUpdateJobId?: (updateJobId: string) => PolicyResult;
  allowRegion?: (kind: OpsOperationKind, regionId: string) => PolicyResult;
  allowCountry?: (kind: "data.update", countryCode: string) => PolicyResult;
  allowDataType?: (dataTypeId: string) => PolicyResult;
  allowCatalogRevision?: (kind: "data.generateApiKeys", catalogRevisionId: string) => PolicyResult;
  allowIntegration?: (integrationId: string) => PolicyResult;
  allowTrustedRevision?: (kind: OpsOperationKind, revisionId: string) => PolicyResult;
}
const NEVER_MANAGE = new Set(["ops-agent", "traefik"]);
async function allowed(value: PolicyResult | undefined): Promise<boolean> {
  return value === undefined ? false : await value;
}

export async function authorizeOpsResources(
  operation: OpsOperation,
  policy: OpsResourcePolicy = {},
): Promise<boolean> {
  if ("serviceId" in operation) {
    if (
      (NEVER_MANAGE.has(operation.serviceId) &&
        operation.kind !== "coreService.restart" &&
        operation.kind !== "service.logs" &&
        operation.kind !== "service.logs.follow") ||
      !(await allowed(policy.allowService?.(operation.kind, operation.serviceId)))
    )
      return false;
  }
  if (operation.kind === "backup.restore") {
    for (const serviceId of operation.serviceIds ?? [])
      if (
        NEVER_MANAGE.has(serviceId) ||
        !(await allowed(policy.allowService?.(operation.kind, serviceId)))
      )
        return false;
  }
  switch (operation.kind) {
    case "backup.create":
    case "backup.delete":
      return allowed(policy.allowBackup?.(operation.kind, operation.backupId));
    case "backup.restore":
      return allowed(
        policy.allowBackup?.(operation.kind, operation.backupId, operation.serviceIds),
      );
    case "motis.primary.promote":
      return allowed(policy.allowPreparedRun?.(operation.preparedRunId));
    case "feedProxy.validateAndReload":
      return allowed(policy.allowCandidate?.(operation.candidateId));
    case "release.pull":
    case "release.apply":
    case "agent.update":
      return allowed(policy.allowRelease?.(operation.kind, operation.releaseId));
    case "appApi.replace":
      return (
        (await allowed(policy.allowRelease?.(operation.kind, operation.releaseId))) &&
        allowed(policy.allowUpdateJobId?.(operation.updateJobId))
      );
    case "system.update":
      return (
        (await allowed(policy.allowRelease?.(operation.kind, operation.releaseId))) &&
        (!operation.createBackup ||
          (operation.backupId !== undefined &&
            (await allowed(policy.allowBackup?.("backup.create", operation.backupId)))))
      );
    case "stack.render":
    case "serviceSelection.apply":
      return allowed(policy.allowTrustedRevision?.(operation.kind, operation.revisionId));
    case "serviceConfig.apply":
    case "vault.apply":
      return allowed(policy.allowTrustedRevision?.(operation.kind, operation.revisionId));
    case "integrationConfig.apply":
      return (
        (await allowed(policy.allowIntegration?.(operation.integrationId))) &&
        allowed(policy.allowTrustedRevision?.(operation.kind, operation.revisionId))
      );
    case "service.build":
      return (
        operation.regionId === undefined ||
        allowed(policy.allowRegion?.(operation.kind, operation.regionId))
      );
    case "services.buildAll":
    case "data.downloadOsm":
    case "data.convertOverpass":
      return operation.regionId === undefined
        ? allowed(policy.allowGlobal?.(operation.kind))
        : allowed(policy.allowRegion?.(operation.kind, operation.regionId));
    case "data.update": {
      const regionAllowed =
        operation.regionId === undefined
          ? await allowed(policy.allowGlobal?.(operation.kind))
          : await allowed(policy.allowRegion?.(operation.kind, operation.regionId));
      if (!regionAllowed) return false;
      for (const countryCode of operation.countryCodes ?? []) {
        if (!(await allowed(policy.allowCountry?.(operation.kind, countryCode)))) return false;
      }
      return true;
    }
    case "data.overtureSync":
    case "data.overtureConflate":
    case "data.searchIndexBuild":
      return allowed(policy.allowRegion?.(operation.kind, operation.regionId));
    case "data.clean":
      return allowed(policy.allowDataType?.(operation.dataTypeId));
    case "data.generateApiKeys":
      return allowed(policy.allowCatalogRevision?.(operation.kind, operation.catalogRevisionId));
    default:
      return "serviceId" in operation ? true : allowed(policy.allowGlobal?.(operation.kind));
  }
}

const changed = z.strictObject({ changed: z.boolean() });
const confirmedMotisStop = z.strictObject({
  changed: z.boolean(),
  state: z.enum(["stopped", "absent"]),
});
const completed = z.strictObject({ completed: z.literal(true) });
const inspection = z.strictObject({ state: z.enum(["ready", "not_ready", "unknown"]) });
const serviceRuntimeState = z.enum([
  "running",
  "stopped",
  "created",
  "restarting",
  "paused",
  "unknown",
]);
const provisioningGeneration = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .nullable();
const dawarichService = <T extends string>(serviceId: T) =>
  z.strictObject({ serviceId: z.literal(serviceId), state: serviceRuntimeState });
const release = z.strictObject({ releaseId: stableIdSchema });
const backup = z.strictObject({ backupId: backupIdSchema });
const backupInventoryEntry = z
  .strictObject({
    backupId: backupIdSchema,
    createdAt: timestampSchema,
    platformVersion: z.string().min(1).max(64).optional(),
    /** Present when the agent could authenticate the exact manifest bytes. */
    manifestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    formatVersion: z.literal(2).optional(),
    /** True only when every file declared by the current manifest was re-hashed. */
    verified: z.boolean().optional(),
    volumes: z
      .array(
        z.strictObject({
          serviceId: serviceIdSchema,
          volumeId: z.string().min(1).max(255),
          mode: z.enum(["tar", "pg_dump"]),
          sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
        }),
      )
      .max(4_096)
      .optional(),
    serviceCount: z.number().int().min(0).max(256),
    volumeCount: z.number().int().min(0).max(4_096),
    totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    corrupt: z.boolean().optional(),
    corruptReason: z.enum(["missing_manifest", "invalid_manifest", "unsafe_entry"]).optional(),
  })
  .superRefine((entry, context) => {
    if (entry.corrupt === true) return;
    if (
      entry.formatVersion !== 2 ||
      entry.verified === undefined ||
      entry.manifestDigest === undefined ||
      entry.volumes === undefined ||
      entry.volumes.some((volume) => volume.sha256 === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Usable backup inventory entries require a verified format-2 manifest",
      });
    }
  });
const repositoryPending = z.strictObject({
  transactionId: repositoryTransactionIdSchema,
  phase: z.enum(["published", "rolledBack"]),
  previousCommit: gitCommitSchema.nullable(),
  recovery: repositoryRecoverySchema,
});
export const configurationApplyResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("committed"),
    revisionId: configurationGenerationRevisionSchema,
    enabledServiceIds: z.array(serviceIdSchema).max(256),
    followUp: z.enum(["complete", "failed"]),
    cleanupFailed: z.boolean(),
  }),
  z.strictObject({
    outcome: z.literal("not_committed"),
    reason: z.enum(["conflict", "busy", "failed"]),
    currentRevisionId: configurationGenerationRevisionSchema.nullable().optional(),
    cleanupFailed: z.boolean(),
  }),
]);
export type ConfigurationApplyResult = z.infer<typeof configurationApplyResultSchema>;
const revision = configurationApplyResultSchema;
const data = z.strictObject({
  completed: z.literal(true),
  resourceId: resourceIdSchema.optional(),
});
const nonnegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedInventoryString = z.string().max(2_048);
const nullableInventoryString = boundedInventoryString.nullable();
const motisGbfsSource = z.strictObject({
  sourceId: boundedInventoryString,
  country: boundedInventoryString,
  status: z.enum(["configured", "excluded"]),
  observation: z.enum(["validated", "unknown"]),
  errorClass: boundedInventoryString.optional(),
  lastObservedSuccess: boundedInventoryString.optional(),
  lastErrorAt: boundedInventoryString.optional(),
  dataAge: z.literal("unknown"),
});
const motisTransitousInventory = z.strictObject({
  configFound: z.boolean(),
  datasetCount: nonnegativeSafeInteger,
  realtimeFeedCount: nonnegativeSafeInteger,
  gbfsFeedCount: nonnegativeSafeInteger,
  feedProxyUrlCount: nonnegativeSafeInteger,
  gbfsProxyUrl: nullableInventoryString,
  feedProxyMode: z.enum(["none", "self-hosted", "transitous-cloud", "mixed"]),
  feedProxyConfigFound: z.boolean(),
  feedProxyVarsFound: z.boolean(),
  feedProxyFeedCount: nonnegativeSafeInteger,
  capabilityState: z.enum(["healthy", "stale", "missing", "error"]),
  capabilityError: boundedInventoryString.optional(),
  activeEpoch: nullableInventoryString,
  candidateEpoch: nullableInventoryString,
  testedAt: nullableInventoryString,
  configHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  licenseHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  rentalProviderCount: nonnegativeSafeInteger,
  rentalProviderGroupCount: nonnegativeSafeInteger,
  rollbackAvailable: z.boolean(),
  operationsProfile: z.enum(["regional-assisted", "regional-sovereign", "planet", "unknown"]),
  activeSlot: z.enum(["A", "B"]).nullable(),
  previousHealthySlot: z.enum(["A", "B"]).nullable(),
  preflightState: z.enum(["passed", "blocked", "missing"]),
  preflightRequiredDiskBytes: nonnegativeSafeInteger.nullable(),
  preflightFreeDiskBytes: nonnegativeSafeInteger.nullable(),
  pinProposalPending: z.boolean(),
  crowdsourceState: z.literal("disabled-pending-review"),
  gbfsCatalog: z.strictObject({
    state: z.enum(["active", "missing", "error"]),
    commit: nullableInventoryString,
    lockedAt: nullableInventoryString,
    registryRows: nonnegativeSafeInteger,
    registryAdded: nonnegativeSafeInteger,
    transitousPreferred: nonnegativeSafeInteger,
    quarantined: nonnegativeSafeInteger,
    validationFailed: nonnegativeSafeInteger,
    sources: z.array(motisGbfsSource).max(500),
  }),
});
const systemCoreServiceId = z.enum([
  "app-api",
  "app-web",
  "data-manager",
  "ops-agent",
  "transitous-runner",
]);
const dockerImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pinnedImageReference = z
  .string()
  .max(512)
  .regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/);

export const OPS_RESULT_SCHEMAS = {
  "controlRetention.acknowledge": z.strictObject({ acknowledged: z.literal(true) }),
  "docker.status": z.strictObject({
    reachable: z.boolean(),
    version: z.string().max(128).optional(),
  }),
  "services.inspect": z.strictObject({
    services: z
      .array(
        z.strictObject({
          serviceId: serviceIdSchema,
          state: serviceRuntimeState,
          actions: serviceActionsSchema,
        }),
      )
      .max(256),
  }),
  "stack.status": z.strictObject({
    services: z
      .array(
        z.strictObject({
          serviceId: serviceIdSchema,
          state: serviceRuntimeState,
          health: z.enum(["healthy", "unhealthy", "starting", "none", "unknown"]).optional(),
        }),
      )
      .max(256),
  }),
  "configuration.hardlinks.inspect": z.strictObject({
    revisionId: configurationGenerationRevisionSchema,
    plan: z
      .array(
        z.strictObject({
          source: z.string().min(1).max(1_024),
          target: z.string().min(1).max(1_024),
          consumerService: serviceIdSchema,
          dataType: z.string().min(1).max(128),
          instance: z.string().min(1).max(128).optional(),
          targetFilename: z.string().min(1).max(255).optional(),
        }),
      )
      .max(256),
  }),
  "configuration.sources.inspect": configurationSourcesInspectionSchema,
  "configuration.hardlinks.preview": configurationHardlinksPreviewSchema,
  "configuration.hardlinks.apply": hardlinkApplySummarySchema,
  "configurationMaintenance.prepare": configurationMaintenanceReceiptSchema,
  "configurationMaintenance.inspect": configurationMaintenanceReceiptSchema,
  "configurationMaintenance.decide": configurationMaintenanceReceiptSchema,
  "configurationMaintenance.settle": configurationMaintenanceReceiptSchema,
  "configuration.inspect": z.strictObject({
    revisionId: configurationGenerationRevisionSchema.nullable(),
    platform: platformConfigurationSchema.optional(),
    integrationConfigDigests: z
      .array(
        z.strictObject({
          integrationId: serviceIdSchema,
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .max(256),
  }),
  "stack.render": revision,
  "stack.start": changed,
  "stack.stop": changed,
  "service.start": changed,
  "service.stop": changed,
  "service.restart": changed,
  "coreService.restart": z.strictObject({
    changed: z.literal(true),
    serviceId: z.enum(["app-api", "traefik"]),
  }),
  "service.recreate": changed,
  "service.recreateIsolated": changed,
  "service.pull": servicePullResultSchema,
  "service.remove": changed,
  "service.update": z.strictObject({
    changed: z.literal(true),
    revisionId: configurationGenerationRevisionSchema,
  }),
  "service.build": completed,
  "services.buildAll": z.strictObject({
    completedServiceIds: z.array(serviceIdSchema).max(256),
    failedServiceIds: z.array(serviceIdSchema).max(256),
  }),
  "service.logs": z.strictObject({
    lines: z
      .array(
        z
          .string()
          .refine(
            (value) => new TextEncoder().encode(value).byteLength <= OPS_MAX_EVENT_MESSAGE_BYTES,
          ),
      )
      .max(OPS_MAX_LOG_TAIL),
    truncated: z.boolean(),
  }),
  "service.logs.follow": z.strictObject({
    lines: z.number().int().min(0).max(OPS_MAX_FOLLOW_LOG_EVENTS),
    truncated: z.boolean(),
  }),
  "dawarich.provisioning.inspect": z.strictObject({
    services: z.tuple([
      dawarichService("dawarich-app"),
      dawarichService("dawarich-sidekiq"),
      dawarichService("dawarich-postgis"),
      dawarichService("dawarich-redis"),
    ]),
    appliedGenerations: z.strictObject({
      app: provisioningGeneration,
      worker: provisioningGeneration,
    }),
  }),
  "release.resolve": release,
  "release.pull": release,
  "release.inspect": z.strictObject({
    currentReleaseId: stableIdSchema.optional(),
    availableReleaseId: stableIdSchema.optional(),
    configuredSelector: z.string().max(128).optional(),
    currentVersion: z.string().max(128).optional(),
    availableVersion: z.string().max(128).optional(),
    availableDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  }),
  "release.apply": release,
  "appApi.replace": z.strictObject({ updateJobId: stableIdSchema, replaced: z.boolean() }),
  "appApi.runtime.inspect": z.strictObject({
    releaseId: stableIdSchema.optional(),
    updateJobId: stableIdSchema.optional(),
  }),
  "agent.update": z.strictObject({ handoffId: stableIdSchema, replaced: z.boolean() }),
  "agent.handoff.inspect": z.strictObject({
    handoffId: stableIdSchema,
    phase: z.enum(OPS_AGENT_HANDOFF_PHASES),
    reason: z.string().max(256).optional(),
  }),
  "backup.list": z.strictObject({
    backups: z.array(backupInventoryEntry).max(OPS_MAX_BACKUP_INVENTORY_ENTRIES),
    warningCount: z.number().int().min(0).max(OPS_MAX_BACKUP_INVENTORY_ENTRIES),
  }),
  "backup.create": backup,
  "backup.restore": backup,
  "backup.delete": backup,
  "system.diagnostics": z.strictObject({
    ok: z.boolean(),
    checks: z
      .array(z.strictObject({ id: stableIdSchema, status: z.enum(["pass", "fail", "warn"]) }))
      .max(128),
  }),
  "system.inspect": z.strictObject({
    dockerReachable: z.boolean(),
    composeReady: z.boolean(),
    maintenanceReady: z.boolean(),
    release: z.strictObject({
      currentReleaseId: stableIdSchema.optional(),
      availableReleaseId: stableIdSchema.optional(),
      configuredSelector: z.string().max(128).optional(),
      currentVersion: z.string().max(128).optional(),
      availableVersion: z.string().max(128).optional(),
      availableDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
    services: z
      .array(
        z.strictObject({
          serviceId: systemCoreServiceId,
          containerState: serviceRuntimeState,
          pinnedImage: pinnedImageReference.optional(),
          runningImageId: dockerImageId.optional(),
          localImageId: dockerImageId.optional(),
          releaseMember: z.boolean(),
          state: z.enum(["current", "update_available", "not_running", "unknown"]),
        }),
      )
      .max(5)
      .refine(
        (services) =>
          new Set(services.map((service) => service.serviceId)).size === services.length,
      ),
  }),
  "system.update": release,
  "serviceRepository.inspect": z.strictObject({
    url: gitRepositoryUrlSchema,
    repository: repositoryIdSchema,
    commit: gitCommitSchema,
    valid: z.boolean(),
    problems: z.array(z.string().max(1_024)).max(64),
    services: z
      .array(z.strictObject({ path: z.string().max(512), manifest: serviceManifestObjectSchema }))
      .max(64),
  }),
  "serviceRepository.publish": z.strictObject({
    repository: repositoryIdSchema,
    commit: gitCommitSchema,
    transactionId: repositoryTransactionIdSchema,
    serviceIds: serviceIdListSchema,
  }),
  "serviceRepository.settle": z.strictObject({
    repository: repositoryIdSchema,
    outcome: z.enum(["commit", "rollback", "release"]),
    changed: z.boolean(),
  }),
  "serviceRepository.remove": z.strictObject({
    repository: repositoryIdSchema,
    removed: z.boolean(),
  }),
  "communityServices.inspect": z.strictObject({
    revisionId: stableIdSchema,
    repositories: z
      .array(
        z.strictObject({
          repository: repositoryIdSchema,
          url: gitRepositoryUrlSchema.nullable(),
          commit: gitCommitSchema.nullable(),
          extensionId: serviceIdSchema.nullable(),
          pending: repositoryPending.nullable(),
        }),
      )
      .max(256),
    services: z
      .array(
        z.strictObject({
          repository: repositoryIdSchema,
          directory: z.string().min(1).max(4_096),
          manifest: serviceManifestObjectSchema,
        }),
      )
      .max(256),
  }),
  "serviceSelection.apply": revision,
  "serviceSelection.inspect": z.strictObject({
    source: z.enum(["env", "file", "default"]),
    roots: z.array(serviceIdSchema).max(256),
  }),
  "serviceConfig.apply": revision,
  "integrationConfig.apply": revision,
  "vault.apply": revision,
  "data.inspect": z.strictObject({
    osm: z.strictObject({
      found: z.boolean(),
      filename: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[^/\\]+$/)
        .optional(),
      sizeBytes: nonnegativeSafeInteger.optional(),
      modifiedAt: timestampSchema.optional(),
      region: boundedInventoryString.optional(),
    }),
    builds: z
      .array(
        z.strictObject({
          target: z.enum([
            "valhalla",
            "osrm",
            "otp",
            "motis",
            "motisFeedProxy",
            "tiles",
            "pelias",
            "nominatim",
            "photon",
            "overpass",
          ]),
          built: z.boolean(),
          builtAt: timestampSchema.optional(),
        }),
      )
      .max(10),
    motisTransitous: motisTransitousInventory,
  }),
  "data.downloadOsm": data,
  "data.downloadFonts": data,
  "data.update": data.extend({ dataWorkflow: dataWorkflowReceiptSchema.optional() }),
  "data.convertOverpass": data,
  "data.link": data,
  "data.clean": data,
  "data.generateApiKeys": data,
  "data.overtureSync": data,
  "data.overtureConflate": data,
  "data.searchIndexBuild": data,
  "data.notablePlacesBuild": data,
  "motis.staging.restart": changed,
  "motis.staging.stop": confirmedMotisStop,
  "motis.primary.restart": changed,
  "motis.primary.stop": confirmedMotisStop,
  "motis.primary.promote": z.strictObject({ activeRunId: stableIdSchema }),
  "feedProxy.validateAndReload": z.strictObject({
    candidateId: stableIdSchema,
    reloaded: z.literal(true),
  }),
  "valhalla.traffic.disable": changed,
  "valhalla.traffic.inspect": inspection,
  "valhalla.traffic.maintain": z.strictObject({
    changed: z.literal(true),
    graphGeneration: z.string().regex(/^[0-9a-f]{64}$/),
    extractGeneration: z.string().regex(/^[0-9a-f]{64}$/),
    waysToEdgesGeneration: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  "valhalla.traffic.refreshWaysToEdges": changed,
  "postgis.capacity.inspect": z.strictObject({ availableBytes: z.number().int().nonnegative() }),
  "transitCredentials.inspect": z.strictObject({
    consumedCredentialsRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    catalogRevisionId: z.string().regex(/^[a-f0-9]{64}$/),
    requiredKeys: z.array(z.string().min(1).max(1024)).max(1000),
    hostCredentialsRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    owner: z.enum(["vault", "file", "environment", "unset"]),
    editable: z.boolean(),
    reason: z.string().max(512).nullable(),
    configuredKeys: z.array(z.string().min(1).max(1024)).max(10000),
    retainedKeys: z.array(z.string().min(1).max(1024)).max(10000),
    appliedCredentialsRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  }),
  "catalogPins.inspect": z
    .strictObject({
      active: catalogPinSetSchema.nullable(),
      catalogRevisionId: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    })
    .refine(
      (value) => value.catalogRevisionId === (value.active?.generationId ?? null),
      "Catalog pair/revision mismatch",
    ),
  "transitousLock.inspect": z.strictObject({
    active: transitousLockRecordSchema.nullable(),
    proposed: transitousLockRecordSchema.nullable(),
    proposal: catalogProposalSchema.nullable().optional(),
    validationInputs: catalogRuntimeInputsSchema.optional(),
    validationBlocker: z.string().max(1024).optional(),
    page: z
      .strictObject({
        proposals: z.array(catalogProposalSummarySchema).max(100),
        total: z.number().int().min(0).max(4096),
        offset: z.number().int().min(0).max(4096),
        nextOffset: z.number().int().min(0).max(4096).nullable(),
      })
      .optional(),
  }),
  "transitousLock.propose": z.strictObject({
    proposalId: z.uuid(),
    catalogRevisionId: z.string().regex(/^[a-f0-9]{64}$/),
    proposed: z.literal(true),
  }),
  "transitousLock.approve": pairedPinApprovalResultSchema,
  "gbfsCatalogLock.inspect": z.strictObject({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    url: z.string().min(1).max(2_048),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    lockedAt: timestampSchema,
    lockedBy: actorLabelSchema,
  }),
} as const satisfies Record<OpsOperationKind, z.ZodType>;

export type OpsResultFor<K extends OpsOperationKind> = z.infer<(typeof OPS_RESULT_SCHEMAS)[K]>;
export type OpsObservedResultFor<K extends OpsOperationKind> = K extends "service.pull"
  ? OpsResultFor<K> | HistoricalServicePullResult
  : OpsResultFor<K>;
/** Status observation only. Fresh execution/settlement continues to use the
 * strict parseOpsResult/parseBoundedOpsResult above the runtime boundary. */
export function parseObservedOpsResult<K extends OpsOperationKind>(
  kind: K,
  value: unknown,
): OpsObservedResultFor<K> {
  if (kind === "service.pull" && historicalServicePullResultSchema.safeParse(value).success)
    return historicalServicePullResultSchema.parse(value) as OpsObservedResultFor<K>;
  return parseBoundedOpsResult(kind, value) as OpsObservedResultFor<K>;
}
export function parseOpsResult<K extends OpsOperationKind>(
  kind: K,
  value: unknown,
): OpsResultFor<K> {
  return OPS_RESULT_SCHEMAS[kind].parse(value) as OpsResultFor<K>;
}
export function parseBoundedOpsResult<K extends OpsOperationKind>(
  kind: K,
  value: unknown,
  maxBytes = OPS_KIND_POLICIES[kind].maxResultBytes,
): OpsResultFor<K> {
  const parsed = parseOpsResult(kind, value);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > maxBytes) {
    throw new Error("Operation result exceeds its byte budget");
  }
  return parsed;
}

export type OpsJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "termination_pending"
  | "timed_out";
const jobState = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "termination_pending",
  "timed_out",
]);
const errorClass = z.enum(
  Object.keys(OPS_PUBLIC_ERROR_MESSAGES) as [OpsErrorClass, ...OpsErrorClass[]],
);
const jobStatus = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  admittedAt: z.number().int().nonnegative().safe().optional(),
  deadlineAt: z.number().int().nonnegative().safe().optional(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  diagnostics: processDiagnosticsSchema.optional(),
  failureResult: opsFailureResultSchema.optional(),
  operationId: operationIdSchema,
  operationKey: operationKeySchema,
  kind: operationKindSchema,
  resourceId: resourceIdSchema,
  state: jobState,
  submittedAt: timestampSchema,
  updatedAt: timestampSchema,
  // Set only when a cancellation request moved this job into
  // `termination_pending`. It survives into the terminal status so a caller can
  // prove that its own request caused containment, rather than inferring it
  // from a failure that had already happened.
  terminationRequestedAt: timestampSchema.optional(),
  result: z.unknown().optional(),
  errorClass: errorClass.optional(),
});
export type OpsJobStatus = z.infer<typeof jobStatus>;
export function parseOpsJobStatus(input: unknown): OpsJobStatus {
  const status = jobStatus.parse(input);
  if (
    status.version === 1 &&
    (status.admittedAt !== undefined ||
      status.deadlineAt !== undefined ||
      status.fingerprint !== undefined ||
      status.diagnostics !== undefined ||
      status.failureResult !== undefined)
  )
    throw new Error("Invalid compatibility identity");
  if (
    status.version === 2 &&
    (status.admittedAt === undefined ||
      status.deadlineAt === undefined ||
      status.fingerprint === undefined ||
      status.deadlineAt <= status.admittedAt)
  )
    throw new Error("Invalid execution identity");
  if (status.failureResult !== undefined && !["failed", "timed_out"].includes(status.state))
    throw new Error("Invalid failure evidence");
  if (
    status.failureResult &&
    new TextEncoder().encode(JSON.stringify(status.failureResult)).byteLength >
      OPS_KIND_POLICIES[status.kind].maxResultBytes
  )
    throw new Error("Failure evidence exceeds budget");
  if (status.state === "succeeded") {
    if (status.result === undefined || status.errorClass !== undefined)
      throw new Error("Invalid operation status");
    parseObservedOpsResult(status.kind, status.result);
  } else if (status.state === "failed" || status.state === "timed_out") {
    if (status.result !== undefined || status.errorClass === undefined)
      throw new Error("Invalid operation status");
  } else if (status.result !== undefined || status.errorClass !== undefined) {
    throw new Error("Invalid operation status");
  }
  return status;
}
type OpsJobStatusBase<K extends OpsOperationKind> = Omit<
  OpsJobStatus,
  "kind" | "state" | "result" | "errorClass"
> & { kind: K };
export type OpsJobStatusFor<K extends OpsOperationKind> =
  | (OpsJobStatusBase<K> & {
      state: "queued" | "running" | "termination_pending";
      result?: never;
      errorClass?: never;
    })
  | (OpsJobStatusBase<K> & {
      state: "succeeded";
      result: OpsObservedResultFor<K>;
      errorClass?: never;
    })
  | (OpsJobStatusBase<K> & {
      state: "failed" | "timed_out";
      result?: never;
      errorClass: OpsErrorClass;
    });
export function parseOpsJobStatusForKind<K extends OpsOperationKind>(
  kind: K,
  input: unknown,
  options: { operationId?: string } = {},
): OpsJobStatusFor<K> {
  const status = parseOpsJobStatus(input);
  if (status.kind !== kind) throw new Error("Operation status kind mismatch");
  if (options.operationId !== undefined && status.operationId !== options.operationId) {
    throw new Error("Operation status ID mismatch");
  }
  return {
    ...status,
    ...(status.result === undefined ? {} : { result: parseObservedOpsResult(kind, status.result) }),
  } as OpsJobStatusFor<K>;
}
const stateEvent = z.strictObject({
  cursor: z.number().int().positive(),
  type: z.literal("state"),
  state: jobState,
});
const logEvent = z.strictObject({
  cursor: z.number().int().positive(),
  type: z.literal("log"),
  stream: z.enum(["stdout", "stderr"]),
  message: z
    .string()
    .refine((value) => new TextEncoder().encode(value).byteLength <= OPS_MAX_EVENT_MESSAGE_BYTES),
});
const eventBatch = z.strictObject({
  version: z.literal(1),
  operationId: operationIdSchema,
  nextCursor: z.number().int().nonnegative(),
  terminal: z.boolean(),
  truncated: z.boolean(),
  events: z.array(z.discriminatedUnion("type", [stateEvent, logEvent])).max(OPS_MAX_EVENT_BATCH),
});
export type OpsEventBatch = z.infer<typeof eventBatch>;
export function parseOpsEventBatch(
  input: unknown,
  options: { operationId?: string; after?: number } = {},
): OpsEventBatch {
  const batch = eventBatch.parse(input);
  if (options.operationId !== undefined && batch.operationId !== options.operationId) {
    throw new Error("Operation event ID mismatch");
  }
  const after = options.after ?? 0;
  let cursor = after;
  for (const [index, event] of batch.events.entries()) {
    const initialTruncatedGap = index === 0 && batch.truncated && event.cursor > cursor + 1;
    if (event.cursor !== cursor + 1 && !initialTruncatedGap) {
      throw new Error("Operation event cursors are invalid");
    }
    cursor = event.cursor;
  }
  if (batch.nextCursor !== cursor) throw new Error("Operation next cursor is invalid");
  return batch;
}

export interface OpsAdmission {
  version?: 1 | 2;
  admittedAt?: number;
  deadlineAt?: number;
  fingerprint?: string;
  execution: "async";
  operationId: string;
  operationKey: string;
  kind: OpsOperationKind;
  state: OpsJobState;
}
const legacyAdmission = z.strictObject({
  execution: z.literal("async"),
  operationId: operationIdSchema,
  operationKey: operationKeySchema,
  kind: operationKindSchema,
  state: jobState,
});
const executionAdmission = legacyAdmission
  .extend({
    version: z.literal(2),
    admittedAt: z.number().int().nonnegative().safe(),
    deadlineAt: z.number().int().nonnegative().safe(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine((value) => value.deadlineAt > value.admittedAt);
/** The historical admission had no inner version. Both forms remain exact, disjoint schemas. */
export function parseOpsAdmission(input: unknown): OpsAdmission {
  return z.union([legacyAdmission, executionAdmission]).parse(input);
}
export interface OpsSyncResult<K extends OpsOperationKind = OpsOperationKind> {
  execution: "sync";
  kind: K;
  value: OpsResultFor<K>;
}
export type OpsSubmitResult<K extends OpsOperationKind = OpsOperationKind> =
  | OpsAdmission
  | OpsSyncResult<K>;
export interface OpsSuccessEnvelope<TResult = unknown> {
  version: 1;
  requestId: string;
  ok: true;
  result: TResult;
}
export interface OpsErrorEnvelope {
  version: 1;
  requestId: string;
  ok: false;
  error: { class: OpsErrorClass; message: string };
}
export type OpsResponseEnvelope<TResult = unknown> = OpsSuccessEnvelope<TResult> | OpsErrorEnvelope;
export function opsSuccess<TResult>(
  requestId: string,
  result: TResult,
): OpsSuccessEnvelope<TResult> {
  return { version: 1, requestId, ok: true, result };
}
export function redactedOpsError(
  requestId: string,
  errorClassValue: OpsErrorClass,
  _cause?: unknown,
): OpsErrorEnvelope {
  return {
    version: 1,
    requestId,
    ok: false,
    error: { class: errorClassValue, message: OPS_PUBLIC_ERROR_MESSAGES[errorClassValue] },
  };
}

export function opsResourceId(operation: OpsOperation): string {
  if ("serviceId" in operation) return operation.serviceId;
  if ("backupId" in operation && operation.backupId) return operation.backupId;
  if ("preparedRunId" in operation) return operation.preparedRunId;
  if ("candidateId" in operation && operation.candidateId) return operation.candidateId;
  if ("repository" in operation) return operation.repository;
  if ("extensionId" in operation) return operation.extensionId;
  if ("integrationId" in operation) return operation.integrationId;
  if ("regionId" in operation && operation.regionId) return operation.regionId;
  if ("dataTypeId" in operation) return operation.dataTypeId;
  if ("releaseId" in operation) return operation.releaseId;
  if ("revisionId" in operation) return operation.revisionId;
  return operation.kind;
}
