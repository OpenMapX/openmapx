import { createHash, timingSafeEqual } from "node:crypto";
import {
  abandonUnstartedLease,
  acquireArtifactTargetLease,
  assertControlStorageAvailable,
  assertFreshControlRoot,
  buildArtifactSpec,
  type ControlInstallation,
  controlRegisteredServiceIds,
  inspectControlAdmission,
  isFixedSingleDataCommand,
  type LeaseStore,
  localLeaseBackend,
  planFixedSingleDataCommand,
  replaceControlRegisteredServiceIds,
  retainAdmittedControlExecution,
  retainDataUpdatePlan,
  retainFixedServiceLifecyclePlan,
  retainFixedSingleDataPlan,
  TargetBusyError,
} from "@openmapx/core/build-artifacts";
import {
  isTrustedConfigurationApplyOperation,
  normalizeExecutionAdmission,
  OPS_KIND_POLICIES,
  OPS_MAX_CLOCK_SKEW_MS,
  OPS_MAX_HTTP_RESPONSE_BYTES,
  OPS_MAX_REQUEST_TTL_MS,
  OPS_OPERATION_KINDS,
  OPS_PROTOCOL_VERSION,
  OpsContractError,
  type OpsErrorClass,
  type OpsOperation,
  type OpsOperationKind,
  type OpsRole,
  opsKindRequiresControlAuthority,
  opsOperationFingerprint,
  opsResourceId,
  opsSuccess,
  parseBoundedOpsResult,
  parseControlRootOperationKey,
  parseOpsRequest,
  redactedOpsError,
  type VerifiedParentExecution,
  verifyApiJobParentExecution,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ArtifactTransferError } from "./artifact-transfer/errors";
import {
  prepareArtifactImportAdmission,
  retainArtifactImportPlan,
} from "./artifact-transfer/import-runtime";
import { prepareDataUpdateAdmission, resolveDataDefaultRegion } from "./data-workflow-runtime";
import type { JobRunner, OpsAudit } from "./job-run";
import { executionFor, type JobRecord, type JobTable } from "./job-table";
import type { OpsJobJournal } from "./journal";
import { LeaseRefused, runLeaseOperation } from "./lease-operations";
import { createMaintenance, maintenanceCapacityReached, pendingHandoffs } from "./maintenance";
import type { MaintenanceRuntime } from "./maintenance-runtime";
import { planConfigurationMaintenance } from "./maintenance-source";
import type { OpsResourceClaimer } from "./policy";
import { productionRegisteredServiceIds } from "./production-runtime";
import {
  OpsAgentBusyError,
  type OpsExecutionContext,
  OpsExecutionFailure,
  OpsHostUpdateRequiredError,
  OpsNotWiredError,
  type OpsRuntime,
} from "./runtime";
import { prepareServiceUpdateAdmission } from "./service-lifecycle-runtime";
import { LEASED_KINDS } from "./settlement";

export const DEFAULT_BODY_LIMIT = 32 * 1024;
// A prepared candidate (up to 768 KiB) and its request envelope.
export const CANDIDATE_BODY_LIMIT = 800 * 1024;
const DEFAULT_CLAIM_TIMEOUT_MS = 5_000;
const MAX_JOB_ID_ATTEMPTS = 8;
// Conservative read-only surface while the release cache cannot be read safely.
const RELEASE_RECOVERY_READ_KINDS = new Set<OpsOperationKind>([
  "configurationMaintenance.inspect",
  "system.diagnostics",
  "docker.status",
  "stack.status",
  "services.inspect",
  "configuration.inspect",
  "configuration.hardlinks.inspect",
  "service.logs",
  "service.logs.follow",
  "dawarich.provisioning.inspect",
  "release.inspect",
  "backup.list",
  "system.inspect",
  "communityServices.inspect",
  "serviceSelection.inspect",
  "data.inspect",
  "valhalla.traffic.inspect",
  "postgis.capacity.inspect",
  "catalogPins.inspect",
  "transitCredentials.inspect",
  "transitousLock.inspect",
  "gbfsCatalogLock.inspect",
  // The API's recovery reads its prepared candidate while a handoff is pending.
  "configuration.candidate.read",
]);
const FALLBACK_REQUEST_ID = "ops1_unavailable000000";
const OPERATION_KIND_SET = new Set<string>(OPS_OPERATION_KINDS);
const REQUEST_ID_PATTERN = /^ops1_[A-Za-z0-9_-]{16,64}$/;
export const OPERATION_ID_PATTERN = /^job1_[A-Za-z0-9_-]{16,64}$/;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function resolveRole(
  authorization: string | undefined,
  tokens: Record<OpsRole, string>,
): OpsRole | null {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  const candidate = digest(match?.[1] ?? "");
  const apiMatches = timingSafeEqual(candidate, digest(tokens.api));
  const dataManagerMatches = timingSafeEqual(candidate, digest(tokens["data-manager"]));
  if (!match) return null;
  if (apiMatches) return "api";
  if (dataManagerMatches) return "data-manager";
  return null;
}

export function validRequestId(value: unknown): string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : FALLBACK_REQUEST_ID;
}

/** Status reads speak only the current protocol; a missing or older header is refused. */
export function supportedPeer(request: { headers: Record<string, unknown> }): boolean {
  return request.headers["x-ops-protocol-version"] === String(OPS_PROTOCOL_VERSION);
}

export function requestIdFromBody(body: unknown): string {
  return validRequestId(
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { requestId?: unknown }).requestId
      : undefined,
  );
}

class RequestGuardError extends Error {
  constructor(
    readonly errorClass: OpsErrorClass,
    readonly statusCode: number,
    /** For a busy refusal by a target lease: the holder, as the reply names it. */
    readonly busyHolder?: string,
  ) {
    super(errorClass);
  }
}

/** A held target at the first admission attempt; the admission is tried again after a grace. */
class BusyAdmission extends Error {
  constructor(readonly target: string) {
    super("Target is busy");
  }
}

/** Waits until no lease holds `target`, or until `until`. */
async function waitForTargetRelease(
  store: LeaseStore,
  target: string,
  until: number,
  signal: AbortSignal,
): Promise<void> {
  while (Date.now() < until && store.list().some((lease) => lease.targets.includes(target))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    signal.throwIfAborted();
  }
}

export class ReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries: number) {}

  accept(requestId: string, expiresAt: number, now: number): void {
    for (const [id, expiry] of this.entries) if (expiry <= now) this.entries.delete(id);
    if (this.entries.has(requestId)) throw new RequestGuardError("replay", 409);
    if (this.entries.size >= this.maxEntries) throw new RequestGuardError("busy", 429);
    this.entries.set(requestId, expiresAt);
  }
}

function validateTiming(
  issuedAt: string,
  expiresAt: string,
  nowMs: number,
): { expiresAtMs: number } {
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (issuedAtMs > nowMs + OPS_MAX_CLOCK_SKEW_MS) throw new RequestGuardError("future", 400);
  if (expiresAtMs <= nowMs) throw new RequestGuardError("stale", 400);
  const ttl = expiresAtMs - issuedAtMs;
  if (ttl <= 0 || ttl > OPS_MAX_REQUEST_TTL_MS) {
    throw new RequestGuardError("validation", 400);
  }
  return { expiresAtMs };
}

function operationKindFromBody(body: unknown): OpsOperationKind | "invalid" {
  const operation =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { operation?: unknown }).operation
      : undefined;
  const kind =
    operation && typeof operation === "object" && !Array.isArray(operation)
      ? (operation as { kind?: unknown }).kind
      : undefined;
  return typeof kind === "string" && OPERATION_KIND_SET.has(kind)
    ? (kind as OpsOperationKind)
    : "invalid";
}

export function immutableSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
    Object.freeze(entry);
  };
  freeze(snapshot);
  return snapshot;
}

export function classify(error: unknown): { errorClass: OpsErrorClass; statusCode: number } {
  if (error instanceof ArtifactTransferError)
    return {
      errorClass:
        error.statusCode === 404
          ? "not_found"
          : error.statusCode === 503
            ? "runtime"
            : error.statusCode === 429
              ? "busy"
              : "conflict",
      statusCode: error.statusCode,
    };
  if (error instanceof OpsContractError) {
    return {
      errorClass: error.errorClass,
      statusCode: error.errorClass === "authorization" ? 403 : 400,
    };
  }
  if (error instanceof RequestGuardError) {
    return { errorClass: error.errorClass, statusCode: error.statusCode };
  }
  if (error instanceof OpsExecutionFailure)
    return {
      errorClass: error.errorClass,
      statusCode:
        error.errorClass === "timeout"
          ? 504
          : error.errorClass === "configuration_prerequisite"
            ? 409
            : 500,
    };
  if (error instanceof OpsHostUpdateRequiredError)
    return { errorClass: "host_update_required", statusCode: 409 };
  if (error instanceof OpsAgentBusyError) return { errorClass: "busy", statusCode: 409 };
  if (error instanceof OpsNotWiredError) return { errorClass: "not_wired", statusCode: 501 };
  return { errorClass: "runtime", statusCode: 500 };
}

/**
 * The one admission pipeline for `POST /v1/operations`: authenticate, parse,
 * check timing and replay, verify the parent, refuse what policy, a pending
 * handoff or release recovery forbid, claim the resource, then either run a
 * sync operation or record an async one. A root acquires its target lease
 * before anything is recorded: a held target refuses it as busy.
 */
export function createAdmission(options: {
  tokens: Record<OpsRole, string>;
  controlInstallation: ControlInstallation | undefined;
  leaseStore: LeaseStore | undefined;
  releaseRecovery: { ready: boolean; reason?: "recovery_required" } | undefined;
  resourceClaimer: OpsResourceClaimer;
  bodyLimit: number | undefined;
  operationTimeoutMs: number | undefined;
  claimTimeoutMs: number | undefined;
  maxConcurrency: number;
  replay: ReplayCache;
  runtime: OpsRuntime;
  journal: OpsJobJournal;
  literalProductionRuntime: boolean;
  dispatch: (
    operation: OpsOperation,
    runtime: OpsRuntime,
    context: OpsExecutionContext,
  ) => Promise<unknown>;
  maintenanceRuntime: MaintenanceRuntime | undefined;
  table: JobTable;
  runner: JobRunner;
  audit: OpsAudit;
  /** The raw audit sink, for a busy refusal that names its holder. */
  auditBusy: (event: {
    role: OpsRole;
    kind: OpsOperationKind | "invalid";
    resourceId: string;
    durationMs: number;
    heldBy: string;
  }) => void;
  now: () => Date;
  randomBytes: (size: number) => Uint8Array;
}) {
  const { table, runtime, now, audit } = options;

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const startedAt = Date.now();
    const requestId = requestIdFromBody(request.body);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    let kind = operationKindFromBody(request.body);
    let resourceId: string = kind;
    try {
      const parsed = parseOpsRequest(request.body, { role });
      const requestLimit =
        parsed.operation.kind === "configuration.candidate.retain"
          ? CANDIDATE_BODY_LIMIT
          : parsed.operation.kind === "transitousLock.propose" || parsed.payload
            ? 772 * 1024
            : (options.bodyLimit ?? DEFAULT_BODY_LIMIT);
      if (Buffer.byteLength(JSON.stringify(request.body), "utf8") > requestLimit)
        throw new RequestGuardError("validation", 413);
      const operation = immutableSnapshot(parsed.operation);
      kind = operation.kind;
      resourceId = opsResourceId(operation);
      const nowMs = now().getTime();
      const timing = validateTiming(parsed.issuedAt, parsed.expiresAt, nowMs);
      options.replay.accept(parsed.requestId, timing.expiresAtMs, nowMs);
      if (
        operation.kind === "lease.acquire" ||
        operation.kind === "lease.read" ||
        operation.kind === "lease.update"
      ) {
        if (!options.controlInstallation || !options.leaseStore)
          throw new RequestGuardError("recovery_required", 409);
        let value: unknown;
        try {
          value = await runLeaseOperation(
            options.controlInstallation,
            options.leaseStore,
            role,
            operation,
          );
        } catch (error) {
          if (error instanceof LeaseRefused) throw new RequestGuardError("authorization", 403);
          // A busy store lock or a file system error may come after the store
          // was written; only a lease rule refusal certainly wrote nothing.
          if (error instanceof services.LockBusyError || (error as { code?: unknown }).code)
            throw new RequestGuardError("runtime", 500);
          throw new RequestGuardError("conflict", 409);
        }
        return reply
          .code(200)
          .send(opsSuccess(parsed.requestId, { execution: "sync", kind, value }));
      }
      const policy = OPS_KIND_POLICIES[operation.kind];
      const operationFingerprint = opsOperationFingerprint(operation);
      if (
        operation.kind === "service.pull" &&
        operation.serviceId === "data-manager" &&
        !operation.candidateId
      )
        throw new OpsExecutionFailure("configuration_prerequisite", {});
      let parent: VerifiedParentExecution | undefined;
      let controlAdmission: ReturnType<typeof inspectControlAdmission> | undefined;
      const parentHeader = request.headers["x-openmapx-parent-execution"];
      // Approval is exclusively a borrowed activation leaf. Installing its
      // future validation runtime must never enable a bearer-only root path.
      if (operation.kind === "transitousLock.approve" && parsed.leaseChild === undefined)
        throw new RequestGuardError("authorization", 403);
      if (parsed.leaseChild !== undefined) {
        if (!options.controlInstallation || role !== "data-manager" || parentHeader !== undefined)
          throw new RequestGuardError("authorization", 403);
        try {
          controlAdmission = inspectControlAdmission(options.controlInstallation, {
            leaseChild: parsed.leaseChild,
            transportPrincipal: "data-manager",
            kind,
            operation,
            operationKey: parsed.operationKey,
            operationFingerprint,
            requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
          });
          parent = controlAdmission.parent;
        } catch {
          throw new RequestGuardError("authorization", 403);
        }
      }
      if (parentHeader !== undefined) {
        if (role !== "api" || typeof parentHeader !== "string")
          throw new RequestGuardError("authorization", 403);
        try {
          parent = verifyApiJobParentExecution(parentHeader, {
            operationKey: parsed.operationKey,
            operationFingerprint,
            requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
          });
        } catch {
          throw new RequestGuardError("authorization", 403);
        }
      }
      // Maintenance steps run inside the agent's own apply; the API never sends one.
      if (
        (isTrustedConfigurationApplyOperation(operation) ||
          operation.kind === "configuration.hardlinks.apply" ||
          operation.kind === "service.recreate" ||
          operation.kind === "service.recreateIsolated") &&
        operation.maintenanceId
      )
        throw new RequestGuardError("authorization", 403);
      if (
        (operation.kind === "configurationMaintenance.prepare" ||
          operation.kind === "configurationMaintenance.apply") &&
        parent?.issuer !== "api"
      )
        throw new RequestGuardError("authorization", 403);
      const normalize = (
        originalAdmittedAt: number,
        deploymentBudgetMs = Math.min(
          policy.timeoutMs,
          options.operationTimeoutMs ?? policy.timeoutMs,
        ),
      ) => {
        try {
          return normalizeExecutionAdmission({
            kind,
            operationKey: parsed.operationKey,
            operationFingerprint,
            admittedAt: originalAdmittedAt,
            requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
            parent,
            deploymentBudgetMs,
          });
        } catch {
          throw new RequestGuardError("validation", 400);
        }
      };
      const fingerprint = operationFingerprint; // Existing sealed claims bind the body, never execution timing.
      const matchesRetained = (job: JobRecord): boolean => {
        try {
          return job.fingerprint === normalize(job.admittedAt, job.deploymentBudgetMs).fingerprint;
        } catch {
          return false;
        }
      };
      if (policy.execution === "async") {
        await table.prune(nowMs);
        const existing = table.byKey.get(`${role}:${parsed.operationKey}`);
        if (existing) {
          if (!matchesRetained(existing)) throw new RequestGuardError("conflict", 409);
          return reply.code(202).send(opsSuccess(parsed.requestId, table.admission(existing)));
        }
        if (table.full()) throw new RequestGuardError("busy", 429);
      }
      const handoffs = options.controlInstallation
        ? pendingHandoffs(options.controlInstallation)
        : new Set<string>();
      if (
        handoffs.size &&
        !RELEASE_RECOVERY_READ_KINDS.has(kind) &&
        !(
          (operation.kind === "configurationMaintenance.apply" ||
            operation.kind === "configurationMaintenance.settle") &&
          handoffs.has(operation.maintenanceId)
        )
      )
        throw new RequestGuardError("busy", 409);
      // The agent keeps a bounded number of maintenance records: a new
      // preparation past that bound is refused before anything is written.
      if (
        operation.kind === "configurationMaintenance.prepare" &&
        options.controlInstallation &&
        maintenanceCapacityReached(options.controlInstallation)
      )
        throw new RequestGuardError("busy", 409);
      if (options.releaseRecovery?.ready === false && !RELEASE_RECOVERY_READ_KINDS.has(kind))
        throw new RequestGuardError("recovery_required", 409);
      if (opsKindRequiresControlAuthority(operation.kind) && !controlAdmission) {
        if (!options.controlInstallation) throw new RequestGuardError("recovery_required", 409);
        try {
          const key = parseControlRootOperationKey(parsed.operationKey);
          if (key.notAfter !== parsed.execution?.requestedDeadlineAt) throw Error();
        } catch {
          throw new RequestGuardError("validation", 400);
        }
        try {
          assertFreshControlRoot(parsed.operationKey, parsed.execution?.requestedDeadlineAt);
        } catch {
          throw new RequestGuardError("recovery_required", 409);
        }
      }
      const normalized = normalize(nowMs);
      if (table.active >= options.maxConcurrency) throw new RequestGuardError("busy", 429);
      table.active += 1;
      const claimController = new AbortController();
      const claimExecution = Promise.resolve().then(() =>
        options.resourceClaimer.claim(operation, fingerprint, claimController.signal, {
          role,
          operationKey: parsed.operationKey,
        }),
      );
      let claimTimer: ReturnType<typeof setTimeout> | undefined;
      let claim: Awaited<ReturnType<OpsResourceClaimer["claim"]>>;
      try {
        claim = await Promise.race([
          claimExecution,
          new Promise<never>((_resolve, reject) => {
            claimTimer = setTimeout(() => {
              claimController.abort();
              reject(new RequestGuardError("timeout", 504));
            }, options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS);
          }),
        ]);
        if (claimTimer !== undefined) clearTimeout(claimTimer);
      } catch (error) {
        if (claimTimer !== undefined) clearTimeout(claimTimer);
        if (error instanceof RequestGuardError && error.errorClass === "timeout") {
          void claimExecution.then(
            () => {
              table.active -= 1;
              audit(role, kind, resourceId, "late_completion", startedAt, "timeout");
            },
            () => {
              table.active -= 1;
              audit(role, kind, resourceId, "terminated", startedAt, "timeout");
            },
          );
          audit(role, kind, resourceId, "timeout", startedAt, "timeout");
          return reply.code(504).send(redactedOpsError(parsed.requestId, "timeout"));
        }
        table.active -= 1;
        throw error;
      }
      try {
        if (
          !claim ||
          claim.fingerprint !== fingerprint ||
          opsOperationFingerprint(claim.operation as OpsOperation) !== fingerprint ||
          !claim.capability ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(claim.capability.revisionId) ||
          !claim.capability.values ||
          typeof claim.capability.values !== "object" ||
          Array.isArray(claim.capability.values) ||
          Object.keys(claim.capability.values).length > 64 ||
          Object.entries(claim.capability.values).some(
            ([key, value]) =>
              !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key) ||
              (value !== null && !["string", "number", "boolean"].includes(typeof value)) ||
              (typeof value === "number" && !Number.isFinite(value)),
          ) ||
          Buffer.byteLength(JSON.stringify(claim.capability), "utf8") > 512 * 1024
        ) {
          throw new OpsContractError("authorization", "Operation resource is not permitted");
        }
        claim = immutableSnapshot({
          fingerprint: claim.fingerprint,
          operation: claim.operation,
          source: claim.source,
          // The payload is held in memory for the run only, never journaled.
          capability: parsed.payload
            ? { ...claim.capability, trustedConfiguration: parsed.payload }
            : claim.capability,
        });
      } catch {
        table.active -= 1;
        throw new OpsContractError("authorization", "Operation resource is not permitted");
      }

      if (policy.execution === "async") {
        const ownerKey = `${role}:${parsed.operationKey}`;
        // A held target is retried once, after a short grace spent outside the
        // admission lock, so a holder that is finishing can release meanwhile.
        let graceSpent = false;
        const admit = async () => {
          const retained = table.byKey.get(ownerKey);
          if (retained) {
            if (!matchesRetained(retained)) {
              throw new RequestGuardError("conflict", 409);
            }
            return { type: "retained", job: retained } as const;
          }
          if (table.full()) throw new RequestGuardError("busy", 429);
          if (options.controlInstallation && opsKindRequiresControlAuthority(parsed.operation.kind))
            try {
              assertControlStorageAvailable(options.controlInstallation);
            } catch {
              throw new RequestGuardError("busy", 429);
            }
          if (normalized.deadlineAt <= now().getTime()) throw new RequestGuardError("timeout", 504);
          const timestamp = new Date(normalized.admittedAt).toISOString();
          let operationId: string | undefined = controlAdmission?.execution.executionId;
          if (operationId && table.byId.has(operationId))
            throw new RequestGuardError("conflict", 409);
          try {
            for (let attempt = 0; !operationId && attempt < MAX_JOB_ID_ATTEMPTS; attempt += 1) {
              const candidate = `job1_${Buffer.from(options.randomBytes(18)).toString("base64url")}`;
              if (OPERATION_ID_PATTERN.test(candidate) && !table.byId.has(candidate)) {
                operationId = candidate;
                break;
              }
            }
          } catch {
            throw new RequestGuardError("runtime", 500);
          }
          if (!operationId) throw new RequestGuardError("busy", 429);
          const job: JobRecord = {
            ...(parsed.leaseChild ? { leaseChild: parsed.leaseChild } : {}),
            role,
            operation,
            operationId,
            operationKey: parsed.operationKey,
            executionVersion: 2,
            requestVersion: parsed.version,
            ...normalized,
            operationFingerprint,
            requestedDeadlineAt: parsed.execution?.requestedDeadlineAt,
            parent,
            deploymentBudgetMs: Math.min(
              policy.timeoutMs,
              options.operationTimeoutMs ?? policy.timeoutMs,
            ),
            resourceId,
            state: "queued",
            submittedAt: timestamp,
            updatedAt: timestamp,
            cursor: 0,
            events: [],
            eventBytes: 0,
            eventsTruncated: false,
          };
          // Prepared compatibility checks are read-only and precede durable
          // root admission. A stale preview creates no uncertain host owner.
          const preparedArtifactImport =
            job.operation.kind === "artifactTransfer.import"
              ? await prepareArtifactImportAdmission(runtime, job.operation)
              : undefined;
          // The target lease is the one admission: a held target refuses the
          // operation as busy before anything is recorded. Its targets, and a
          // maintenance plan, are read first. Planning only reads, so a
          // refusal there ends the recorded job failed with that refusal, and
          // nothing waits for an operator.
          const rootAdmission =
            !controlAdmission && opsKindRequiresControlAuthority(operation.kind);
          let planningRefusal: OpsErrorClass | undefined;
          let admissionFailure: { error: unknown } | undefined;
          let maintenanceAdmission:
            | Awaited<ReturnType<typeof planConfigurationMaintenance>>
            | undefined;
          let targets: string[] = [];
          let admittedLease: string | undefined;
          if (rootAdmission) {
            try {
              if (!options.controlInstallation) throw Error("Control trust unavailable");
              maintenanceAdmission =
                job.operation.kind === "configurationMaintenance.prepare"
                  ? await planConfigurationMaintenance(runtime, {
                      installation: options.controlInstallation,
                      execution: executionFor(job),
                      operation: job.operation,
                      apiParent:
                        job.parent ??
                        (() => {
                          throw Error("API maintenance parent required");
                        })(),
                      journal: options.journal,
                      signal: claimController.signal,
                    })
                  : undefined;
              if (options.literalProductionRuntime)
                replaceControlRegisteredServiceIds(
                  options.controlInstallation,
                  await productionRegisteredServiceIds(runtime),
                );
              targets =
                maintenanceAdmission?.plan.serviceIds ??
                (operation.kind === "artifactTransfer.export"
                  ? [
                      ...new Set([
                        operation.serviceId,
                        ...buildArtifactSpec(operation.serviceId).consumers,
                      ]),
                    ]
                  : "serviceId" in operation &&
                      ![
                        "service.start",
                        "service.recreate",
                        "service.recreateIsolated",
                        "service.update",
                      ].includes(operation.kind)
                    ? [operation.serviceId]
                    : controlRegisteredServiceIds(options.controlInstallation));
            } catch (error) {
              planningRefusal = error instanceof OpsExecutionFailure ? error.errorClass : "runtime";
            }
            if (!planningRefusal && LEASED_KINDS.has(operation.kind) && options.leaseStore)
              try {
                admittedLease = (
                  await localLeaseBackend(options.leaseStore).acquire({
                    owner: executionFor(job),
                    ownerKind: operation.kind,
                    targets: operation.kind.startsWith("valhalla.") ? ["valhalla"] : targets,
                  })
                ).leaseId;
              } catch (error) {
                if (!(error instanceof TargetBusyError)) admissionFailure = { error };
                else if (!graceSpent) throw new BusyAdmission(error.target);
                else {
                  options.auditBusy({
                    role,
                    kind,
                    resourceId,
                    durationMs: Date.now() - startedAt,
                    heldBy: error.message,
                  });
                  throw new RequestGuardError("busy", 409, error.message);
                }
              }
          }
          if (planningRefusal) {
            job.state = "failed";
            job.errorClass = planningRefusal;
            job.terminalAt = now().getTime();
            table.pushState(job, job.state);
          }
          try {
            await table.admit(job);
          } catch (error) {
            // Nothing was recorded, so nothing ran under the lease.
            if (admittedLease && options.leaseStore)
              await abandonUnstartedLease(options.leaseStore, admittedLease, executionFor(job));
            throw error;
          }
          if (planningRefusal) return { type: "refused", job } as const;
          if (rootAdmission) {
            try {
              if (admissionFailure) throw admissionFailure.error;
              if (!options.controlInstallation) throw Error("Control trust unavailable");
              const maintenancePlan = maintenanceAdmission?.plan;
              const fixedDataPlan = isFixedSingleDataCommand(job.operation.kind)
                ? planFixedSingleDataCommand(
                    executionFor(job),
                    job.operation,
                    targets,
                    "regionId" in job.operation && job.operation.regionId === undefined
                      ? resolveDataDefaultRegion(runtime)
                      : undefined,
                  )
                : undefined;
              const dataUpdatePlan =
                job.operation.kind === "data.update"
                  ? prepareDataUpdateAdmission(runtime, executionFor(job), job.operation, targets)
                  : undefined;
              const lifecyclePlan =
                job.operation.kind === "service.update"
                  ? prepareServiceUpdateAdmission(
                      runtime,
                      executionFor(job),
                      job.operation,
                      targets,
                    )
                  : undefined;
              const authority = await retainAdmittedControlExecution(options.controlInstallation, {
                execution: executionFor(job),
                operation: job.operation,
                kind: job.operation.kind,
                admittedAt: job.admittedAt,
                requestedDeadlineAt: job.requestedDeadlineAt,
                parent: job.parent,
                serviceIds: targets,
                ...(fixedDataPlan ? { reservations: [fixedDataPlan.rootReservation] } : {}),
                ...(dataUpdatePlan
                  ? {
                      reservations: [
                        dataUpdatePlan.dataReservation,
                        dataUpdatePlan.finalizationReservation,
                      ],
                    }
                  : {}),
                ...(lifecyclePlan ? { reservations: [lifecyclePlan.rootReservation] } : {}),
                ...(maintenancePlan ? { reservations: maintenancePlan.reservations } : {}),
              });
              if (fixedDataPlan) retainFixedSingleDataPlan(authority, fixedDataPlan);
              if (dataUpdatePlan) retainDataUpdatePlan(authority, dataUpdatePlan);
              if (preparedArtifactImport)
                retainArtifactImportPlan(authority, preparedArtifactImport);
              if (lifecyclePlan) retainFixedServiceLifecyclePlan(authority, lifecyclePlan);
              table.authorities.set(job.operationId, authority);
              if (LEASED_KINDS.has(job.operation.kind)) {
                const lease = await acquireArtifactTargetLease({
                  serviceIds: job.operation.kind.startsWith("valhalla.") ? ["valhalla"] : targets,
                  owner: authority,
                });
                table.leases.set(job.operationId, lease);
                if (maintenanceAdmission)
                  createMaintenance(options.controlInstallation, {
                    ...maintenanceAdmission,
                    apiJobId: maintenanceAdmission.plan.apiParent.apiJobId,
                    leaseId: lease.leaseId,
                    now: now(),
                  });
              }
            } catch (error) {
              // Nothing has started yet, so a lease taken at admission holds nothing.
              if (admittedLease && options.leaseStore) {
                table.leases.delete(job.operationId);
                await abandonUnstartedLease(options.leaseStore, admittedLease, executionFor(job));
              }
              table.forceRecoveryRequired(job);
              await table.persist();
              throw error;
            }
          }
          if (controlAdmission && parsed.leaseChild) {
            try {
              if (!options.controlInstallation)
                throw Error("Missing durable control admission context");
              const lease = await controlAdmission.adopt(executionFor(job));
              const authority = await retainAdmittedControlExecution(options.controlInstallation, {
                execution: executionFor(job),
                kind: job.operation.kind,
                operation: job.operation,
                admittedAt: job.admittedAt,
                requestedDeadlineAt: job.requestedDeadlineAt,
                parent: job.parent,
                leaseChild: parsed.leaseChild,
                serviceIds: lease.serviceIds,
              });
              table.leases.set(job.operationId, lease);
              table.authorities.set(job.operationId, authority);
            } catch (error) {
              // The receiver may already have adopted. This identity remains
              // observable as recovery-required and is never dispatched again.
              table.forceRecoveryRequired(job);
              try {
                await table.persist();
              } catch (persistence) {
                throw new AggregateError(
                  [error, persistence],
                  "Control adoption requires reconciliation",
                );
              }
              throw error;
            }
          }
          return { type: "new", job } as const;
        };
        const admission = await table
          .withAdmissionLock(admit)
          .catch(async (error) => {
            if (!(error instanceof BusyAdmission) || !options.leaseStore) throw error;
            await waitForTargetRelease(
              options.leaseStore,
              error.target,
              Math.min(Date.now() + 5000, normalized.deadlineAt),
              claimController.signal,
            );
            graceSpent = true;
            return table.withAdmissionLock(admit);
          })
          .catch(async (error) => {
            table.active -= 1;
            throw error instanceof RequestGuardError
              ? error
              : error instanceof TargetBusyError
                ? new RequestGuardError("busy", 409, error.message)
                : new RequestGuardError("runtime", 500);
          });
        if (admission.type === "retained" || admission.type === "refused") {
          table.active -= 1;
          if (admission.type === "refused")
            audit(role, kind, resourceId, "error", startedAt, admission.job.errorClass);
          return reply.code(202).send(opsSuccess(parsed.requestId, table.admission(admission.job)));
        }
        const { job } = admission;
        if (normalized.deadlineAt <= now().getTime()) {
          table.stickyRecoveryRequired.add(job.operationId);
          await table
            .transition(job, "failed", {
              result: undefined,
              errorClass: "recovery_required",
              terminalAt: now().getTime(),
            })
            .catch(() => table.forceRecoveryRequired(job));
          table.active -= 1;
          throw new RequestGuardError("runtime", 500);
        }
        await options.runner.run(job, startedAt, claim).catch(() => {
          throw new RequestGuardError("runtime", 500);
        });
        return reply.code(202).send(opsSuccess(parsed.requestId, table.admission(job)));
      }
      const controller = new AbortController();
      if (normalized.deadlineAt <= now().getTime()) {
        table.active -= 1;
        throw new RequestGuardError("runtime", 500);
      }
      const timeoutMs = Math.max(0, normalized.deadlineAt - now().getTime());
      const execution = Promise.resolve().then(() => {
        if (normalized.deadlineAt <= now().getTime()) throw new RequestGuardError("timeout", 504);
        const context: OpsExecutionContext = {
          signal: controller.signal,
          execution: Object.freeze({
            executor: "ops-agent",
            principal: role,
            executionId: `job1_${Buffer.from(options.randomBytes(18)).toString("base64url")}`,
            operationKey: parsed.operationKey,
            operationFingerprint,
            fingerprint: normalized.fingerprint,
            deadlineAt: normalized.deadlineAt,
          }),
          emitLog: () => undefined,
          claim,
        };
        return operation.kind === "configurationMaintenance.inspect" && options.maintenanceRuntime
          ? options.maintenanceRuntime.inspect(operation)
          : options.dispatch(operation, runtime, context);
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutResult = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new RequestGuardError("timeout", 504));
          }, timeoutMs);
        });
        const rawResult = await Promise.race([execution, timeoutResult]);
        clearTimeout(timeout);
        const value = parseBoundedOpsResult(operation.kind, rawResult);
        audit(role, kind, resourceId, "success", startedAt);
        const envelope = opsSuccess(parsed.requestId, { execution: "sync", kind, value });
        if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > OPS_MAX_HTTP_RESPONSE_BYTES) {
          throw new RequestGuardError("runtime", 500);
        }
        table.active -= 1;
        return reply.code(200).send(envelope);
      } catch (error) {
        if (timeout !== undefined) clearTimeout(timeout);
        if (error instanceof RequestGuardError && error.errorClass === "timeout") {
          void execution.then(
            () => {
              table.active -= 1;
              audit(role, kind, resourceId, "late_completion", startedAt, "timeout");
            },
            () => {
              table.active -= 1;
              audit(role, kind, resourceId, "terminated", startedAt, "timeout");
            },
          );
          audit(role, kind, resourceId, "timeout", startedAt, "timeout");
          return reply.code(504).send(redactedOpsError(parsed.requestId, "timeout"));
        }
        table.active -= 1;
        throw error;
      }
    } catch (error) {
      const classification = classify(error);
      audit(
        role,
        kind,
        resourceId,
        classification.errorClass === "authorization" ? "denied" : "error",
        startedAt,
        classification.errorClass,
      );
      return reply
        .code(classification.statusCode)
        .send(redactedOpsError(requestId, classification.errorClass, error));
    }
  };
}
