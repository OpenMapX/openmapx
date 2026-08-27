import z from "zod/v4";

export const OPS_PROTOCOL_VERSION = 1 as const;
export const OPS_MAX_LOG_TAIL = 2_000;
export const OPS_MAX_EVENT_MESSAGE_BYTES = 4_096;
export const OPS_MAX_EVENT_BATCH = 100;
export const OPS_MAX_FOLLOW_LOG_EVENTS = 2_000;
export const OPS_MAX_RESULT_BYTES = 1024 * 1024;
export const OPS_MAX_HTTP_RESPONSE_BYTES = OPS_MAX_RESULT_BYTES + 16 * 1024;
export const OPS_MAX_REQUEST_TTL_MS = 30_000;
export const OPS_MAX_CLOCK_SKEW_MS = 5_000;
export const OPS_MAX_BACKUP_ID_LENGTH = 128;
export const OPS_MAX_BACKUP_INVENTORY_ENTRIES = 128;

export const OPS_OPERATION_KINDS = [
  "docker.status",
  "stack.status",
  "stack.render",
  "stack.start",
  "stack.stop",
  "service.start",
  "service.stop",
  "service.restart",
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
  "backup.list",
  "backup.create",
  "backup.restore",
  "backup.delete",
  "system.diagnostics",
  "system.inspect",
  "system.update",
  "extension.repository.inspect",
  "extension.install",
  "extension.update",
  "extension.remove",
  "serviceSelection.apply",
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
  "motis.staging.restart",
  "motis.staging.stop",
  "motis.primary.restart",
  "motis.primary.stop",
  "motis.primary.promote",
  "feedProxy.validateAndReload",
  "valhalla.traffic.inspect",
  "valhalla.traffic.rebuild",
  "valhalla.traffic.refreshWaysToEdges",
  "valhalla.traffic.applyPredicted",
  "postgis.capacity.inspect",
  "transitousLock.inspect",
  "transitousLock.propose",
  "transitousLock.approve",
  "gbfsCatalogLock.inspect",
] as const;

export type OpsOperationKind = (typeof OPS_OPERATION_KINDS)[number];
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

export const OPS_KIND_POLICIES = {
  "docker.status": sync("api", 5_000),
  "stack.status": sync("api", 15_000, 256 * 1024),
  "stack.render": asyncEffect("api", 120_000),
  "stack.start": asyncEffect("api", 5 * 60_000),
  "stack.stop": asyncEffect("api", 5 * 60_000),
  "service.start": asyncEffect("api", 3 * 60_000),
  "service.stop": asyncEffect("api", 3 * 60_000),
  "service.restart": asyncEffect("api", 2 * 60_000),
  "service.recreate": asyncEffect("api", 5 * 60_000),
  "service.recreateIsolated": asyncEffect("api", 5 * 60_000),
  "service.pull": asyncEffect("api", 15 * 60_000),
  "service.remove": asyncEffect("api", 3 * 60_000),
  "service.update": asyncEffect("api", 15 * 60_000),
  "service.build": asyncEffect("api", 30 * 60_000),
  "services.buildAll": asyncEffect("api", 30 * 60_000, 16 * 1024),
  "service.logs": sync("api", 30_000, 1024 * 1024),
  "service.logs.follow": asyncEffect("api", 15 * 60_000, 64 * 1024),
  "dawarich.provisioning.inspect": sync("api", 30_000),
  "release.resolve": asyncEffect("api", 2 * 60_000),
  "release.pull": asyncEffect("api", 15 * 60_000),
  "release.inspect": sync("api", 30_000, 256 * 1024),
  "release.apply": asyncEffect("api", 30 * 60_000),
  "appApi.replace": asyncEffect("api", 10 * 60_000),
  "appApi.runtime.inspect": sync("api", 30_000),
  "backup.list": sync("api", 30_000, 256 * 1024),
  "backup.create": asyncEffect("api", 30 * 60_000),
  "backup.restore": asyncEffect("api", 30 * 60_000),
  "backup.delete": asyncEffect("api", 5 * 60_000),
  "system.diagnostics": asyncEffect("api", 10 * 60_000, 256 * 1024),
  "system.inspect": sync("api", 30_000, 256 * 1024),
  "system.update": asyncEffect("api", 30 * 60_000),
  "extension.repository.inspect": asyncEffect("api", 5 * 60_000, 256 * 1024),
  "extension.install": asyncEffect("api", 30 * 60_000),
  "extension.update": asyncEffect("api", 30 * 60_000),
  "extension.remove": asyncEffect("api", 15 * 60_000),
  "serviceSelection.apply": asyncEffect("api", 2 * 60_000),
  "serviceConfig.apply": asyncEffect("api", 2 * 60_000),
  "integrationConfig.apply": asyncEffect("api", 2 * 60_000),
  "vault.apply": asyncEffect("api", 2 * 60_000),
  "data.inspect": sync("api", 30_000, 256 * 1024),
  "data.downloadOsm": asyncEffect("api", 30 * 60_000),
  "data.downloadFonts": asyncEffect("api", 15 * 60_000),
  "data.update": asyncEffect("api", 30 * 60_000),
  "data.convertOverpass": asyncEffect("api", 30 * 60_000),
  "data.link": asyncEffect("api", 10 * 60_000),
  "data.clean": asyncEffect("api", 10 * 60_000),
  "data.generateApiKeys": asyncEffect("api", 10 * 60_000),
  "data.overtureSync": asyncEffect("api", 30 * 60_000),
  "data.overtureConflate": asyncEffect("api", 30 * 60_000),
  "data.searchIndexBuild": asyncEffect("api", 30 * 60_000),
  "motis.staging.restart": asyncEffect("data-manager", 2 * 60_000),
  "motis.staging.stop": asyncEffect("data-manager", 2 * 60_000),
  "motis.primary.restart": asyncEffect("data-manager", 2 * 60_000),
  "motis.primary.stop": asyncEffect("data-manager", 2 * 60_000),
  "motis.primary.promote": asyncEffect("data-manager", 10 * 60_000),
  "feedProxy.validateAndReload": asyncEffect("data-manager", 2 * 60_000),
  "valhalla.traffic.inspect": sync("data-manager", 30_000),
  "valhalla.traffic.rebuild": asyncEffect("data-manager", 30 * 60_000),
  "valhalla.traffic.refreshWaysToEdges": asyncEffect("data-manager", 30 * 60_000),
  "valhalla.traffic.applyPredicted": asyncEffect("data-manager", 30 * 60_000),
  "postgis.capacity.inspect": sync("data-manager", 30_000),
  "transitousLock.inspect": sync("data-manager", 30_000),
  "transitousLock.propose": sync("data-manager", 30_000),
  "transitousLock.approve": sync("data-manager", 30_000),
  "gbfsCatalogLock.inspect": sync("data-manager", 30_000),
} as const satisfies Record<OpsOperationKind, OpsKindPolicy>;

const operationKindSchema = z.enum(OPS_OPERATION_KINDS);
const serviceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const stableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
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
  kindOnly("docker.status"),
  kindOnly("stack.status"),
  z.strictObject({ kind: z.literal("stack.render"), revisionId: stableIdSchema }),
  kindOnly("stack.start"),
  kindOnly("stack.stop"),
  serviceOperation("service.start"),
  serviceOperation("service.stop"),
  serviceOperation("service.restart"),
  serviceOperation("service.recreate"),
  serviceOperation("service.recreateIsolated"),
  serviceOperation("service.pull"),
  serviceOperation("service.remove"),
  serviceOperation("service.update"),
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
    createBackup: z.boolean(),
    backupId: backupIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("extension.repository.inspect"),
    catalogEntryId: stableIdSchema,
    catalogRevisionId: stableIdSchema,
  }),
  z.strictObject({
    kind: z.literal("extension.install"),
    extensionId: serviceIdSchema,
    catalogEntryId: stableIdSchema,
    catalogRevisionId: stableIdSchema,
  }),
  z.strictObject({
    kind: z.literal("extension.update"),
    extensionId: serviceIdSchema,
    catalogRevisionId: stableIdSchema,
  }),
  z.strictObject({ kind: z.literal("extension.remove"), extensionId: serviceIdSchema }),
  z.strictObject({ kind: z.literal("serviceSelection.apply"), revisionId: stableIdSchema }),
  z.strictObject({
    kind: z.literal("serviceConfig.apply"),
    serviceId: serviceIdSchema,
    revisionId: stableIdSchema,
  }),
  z.strictObject({
    kind: z.literal("integrationConfig.apply"),
    integrationId: serviceIdSchema,
    revisionId: stableIdSchema,
  }),
  z.strictObject({
    kind: z.literal("vault.apply"),
    serviceId: serviceIdSchema,
    revisionId: stableIdSchema,
  }),
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
  kindOnly("motis.staging.restart"),
  kindOnly("motis.staging.stop"),
  kindOnly("motis.primary.restart"),
  kindOnly("motis.primary.stop"),
  z.strictObject({ kind: z.literal("motis.primary.promote"), preparedRunId: stableIdSchema }),
  z.strictObject({ kind: z.literal("feedProxy.validateAndReload"), candidateId: stableIdSchema }),
  kindOnly("valhalla.traffic.inspect"),
  kindOnly("valhalla.traffic.rebuild"),
  kindOnly("valhalla.traffic.refreshWaysToEdges"),
  kindOnly("valhalla.traffic.applyPredicted"),
  kindOnly("postgis.capacity.inspect"),
  // The catalog lock lives under the repository's `infra/docker/`, which only
  // the operations agent may write. Callers name a pinned ref, never a path.
  kindOnly("transitousLock.inspect"),
  z.strictObject({
    kind: z.literal("transitousLock.propose"),
    ref: transitousRefSchema,
    submodules: transitousSubmodulesSchema,
    lockedBy: actorLabelSchema,
    comment: z.string().min(1).max(512).optional(),
  }),
  z.strictObject({
    kind: z.literal("transitousLock.approve"),
    // The exact ref being activated, so an approval cannot land on a proposal
    // that changed after the reviewer read it.
    ref: transitousRefSchema,
    approvedBy: actorLabelSchema,
  }),
  kindOnly("gbfsCatalogLock.inspect"),
]);
export type OpsOperation = z.infer<typeof opsOperationSchema>;

const opsRequestSchema = z.strictObject({
  version: z.literal(OPS_PROTOCOL_VERSION),
  requestId: requestIdSchema,
  operationKey: operationKeySchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  operation: opsOperationSchema,
});
export type OpsRequest = z.infer<typeof opsRequestSchema>;

export function authorizeOpsOperation(role: OpsRole, kind: OpsOperationKind): boolean {
  return OPS_KIND_POLICIES[kind].role === role;
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
  | "recovery_required"
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
  not_found: "Operation was not found",
  not_wired: "Operation is not available",
  recovery_required: "Operation requires an explicit retry",
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
    kind: "release.pull" | "release.apply" | "appApi.replace" | "system.update",
    releaseId: string,
  ) => PolicyResult;
  allowUpdateJobId?: (updateJobId: string) => PolicyResult;
  allowRegion?: (kind: OpsOperationKind, regionId: string) => PolicyResult;
  allowCountry?: (kind: "data.update", countryCode: string) => PolicyResult;
  allowDataType?: (dataTypeId: string) => PolicyResult;
  allowCatalogRevision?: (kind: "data.generateApiKeys", catalogRevisionId: string) => PolicyResult;
  allowExtension?: (
    kind: "extension.install" | "extension.update" | "extension.remove",
    extensionId: string,
  ) => PolicyResult;
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
      NEVER_MANAGE.has(operation.serviceId) ||
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
    case "extension.repository.inspect":
      return (
        (await allowed(policy.allowTrustedRevision?.(operation.kind, operation.catalogEntryId))) &&
        allowed(policy.allowTrustedRevision?.(operation.kind, operation.catalogRevisionId))
      );
    case "extension.install":
      return (
        (await allowed(policy.allowExtension?.(operation.kind, operation.extensionId))) &&
        (await allowed(policy.allowTrustedRevision?.(operation.kind, operation.catalogEntryId))) &&
        allowed(policy.allowTrustedRevision?.(operation.kind, operation.catalogRevisionId))
      );
    case "extension.update":
      return (
        (await allowed(policy.allowExtension?.(operation.kind, operation.extensionId))) &&
        allowed(policy.allowTrustedRevision?.(operation.kind, operation.catalogRevisionId))
      );
    case "extension.remove":
      return allowed(policy.allowExtension?.(operation.kind, operation.extensionId));
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
const backupInventoryEntry = z.strictObject({
  backupId: backupIdSchema,
  createdAt: timestampSchema,
  platformVersion: z.string().min(1).max(64).optional(),
  serviceCount: z.number().int().min(0).max(256),
  volumeCount: z.number().int().min(0).max(4_096),
  totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  corrupt: z.boolean().optional(),
  corruptReason: z.enum(["missing_manifest", "invalid_manifest", "unsafe_entry"]).optional(),
});
const extension = z.strictObject({ extensionId: serviceIdSchema, revisionId: stableIdSchema });
const revision = z.strictObject({ revisionId: stableIdSchema });
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
const systemCoreServiceId = z.enum(["app-api", "app-web", "data-manager"]);
const dockerImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pinnedImageReference = z
  .string()
  .max(512)
  .regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/);

export const OPS_RESULT_SCHEMAS = {
  "docker.status": z.strictObject({
    reachable: z.boolean(),
    version: z.string().max(128).optional(),
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
  "stack.render": revision,
  "stack.start": changed,
  "stack.stop": changed,
  "service.start": changed,
  "service.stop": changed,
  "service.restart": changed,
  "service.recreate": changed,
  "service.recreateIsolated": changed,
  "service.pull": changed,
  "service.remove": changed,
  "service.update": changed,
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
  }),
  "release.apply": release,
  "appApi.replace": z.strictObject({ updateJobId: stableIdSchema, replaced: z.boolean() }),
  "appApi.runtime.inspect": z.strictObject({
    releaseId: stableIdSchema.optional(),
    updateJobId: stableIdSchema.optional(),
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
      .max(3)
      .refine(
        (services) =>
          new Set(services.map((service) => service.serviceId)).size === services.length,
      ),
  }),
  "system.update": release,
  "extension.repository.inspect": z.strictObject({
    catalogEntryId: stableIdSchema,
    revisionId: stableIdSchema,
    valid: z.boolean(),
  }),
  "extension.install": extension,
  "extension.update": extension,
  "extension.remove": z.strictObject({ extensionId: serviceIdSchema, removed: z.boolean() }),
  "serviceSelection.apply": revision,
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
  "data.update": data,
  "data.convertOverpass": data,
  "data.link": data,
  "data.clean": data,
  "data.generateApiKeys": data,
  "data.overtureSync": data,
  "data.overtureConflate": data,
  "data.searchIndexBuild": data,
  "motis.staging.restart": changed,
  "motis.staging.stop": changed,
  "motis.primary.restart": changed,
  "motis.primary.stop": changed,
  "motis.primary.promote": z.strictObject({ activeRunId: stableIdSchema }),
  "feedProxy.validateAndReload": z.strictObject({
    candidateId: stableIdSchema,
    reloaded: z.literal(true),
  }),
  "valhalla.traffic.inspect": inspection,
  "valhalla.traffic.rebuild": changed,
  "valhalla.traffic.refreshWaysToEdges": changed,
  "valhalla.traffic.applyPredicted": changed,
  "postgis.capacity.inspect": z.strictObject({ availableBytes: z.number().int().nonnegative() }),
  "transitousLock.inspect": z.strictObject({
    active: transitousLockRecordSchema.nullable(),
    proposed: transitousLockRecordSchema.nullable(),
  }),
  "transitousLock.propose": z.strictObject({ ref: transitousRefSchema, proposed: z.literal(true) }),
  "transitousLock.approve": z.strictObject({
    ref: transitousRefSchema,
    lockedAt: timestampSchema,
  }),
  "gbfsCatalogLock.inspect": z.strictObject({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    url: z.string().min(1).max(2_048),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    lockedAt: timestampSchema,
    lockedBy: actorLabelSchema,
  }),
} as const satisfies Record<OpsOperationKind, z.ZodType>;

export type OpsResultFor<K extends OpsOperationKind> = z.infer<(typeof OPS_RESULT_SCHEMAS)[K]>;
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
  version: z.literal(1),
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
  if (status.state === "succeeded") {
    if (status.result === undefined || status.errorClass !== undefined)
      throw new Error("Invalid operation status");
    parseOpsResult(status.kind, status.result);
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
      result: OpsResultFor<K>;
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
    ...(status.result === undefined ? {} : { result: parseOpsResult(kind, status.result) }),
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
  execution: "async";
  operationId: string;
  operationKey: string;
  kind: OpsOperationKind;
  state: OpsJobState;
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
  if ("candidateId" in operation) return operation.candidateId;
  if ("extensionId" in operation) return operation.extensionId;
  if ("integrationId" in operation) return operation.integrationId;
  if ("regionId" in operation && operation.regionId) return operation.regionId;
  if ("dataTypeId" in operation) return operation.dataTypeId;
  if ("releaseId" in operation) return operation.releaseId;
  if ("revisionId" in operation) return operation.revisionId;
  if ("catalogEntryId" in operation) return operation.catalogEntryId;
  return operation.kind;
}
