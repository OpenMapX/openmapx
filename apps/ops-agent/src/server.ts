import { randomBytes as nodeRandomBytes } from "node:crypto";
import {
  beginControlEffect,
  type ControlInstallation,
  inspectControlAdmission,
  type LeaseStore,
  restoreAdmittedControlExecution,
  retainControlEffectReceipt,
  settleArtifactTargetLeaseChild,
  startControlPrune,
  verifyControlEffectSettlement,
  verifyRetainedArtifactTargetSettlement,
} from "@openmapx/core/build-artifacts";
import {
  executionFingerprint,
  OPS_MAX_EVENT_BATCH,
  OPS_PROTOCOL_VERSION,
  OpsContractError,
  type OpsErrorClass,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResourcePolicy,
  type OpsRole,
  opsOperationFingerprint,
  opsSuccess,
  parseBoundedOpsResult,
  redactedOpsError,
} from "@openmapx/core/ops";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CANDIDATE_BODY_LIMIT,
  classify,
  createAdmission,
  DEFAULT_BODY_LIMIT,
  immutableSnapshot,
  OPERATION_ID_PATTERN,
  ReplayCache,
  requestIdFromBody,
  resolveRole,
  supportedPeer,
  validRequestId,
} from "./admission";
import { createImportRecovery } from "./artifact-transfer/import-recovery";
import { registerArtifactTransferLifecycle } from "./artifact-transfer/lifecycle";
import { registerArtifactTransferRoutes } from "./artifact-transfer/routes";
import type { ArtifactTransferStore } from "./artifact-transfer/store";
import { readCommittedCatalogApproval } from "./catalog-approval-runtime";
import { configurationHandoffBlocksReplacement } from "./configuration-handoff";
import {
  type DawarichSubjectExportRouteOptions,
  registerDawarichSubjectExportRoute,
} from "./dawarich-subject-export";
import { registerOpsIngressRateLimit } from "./ingress-rate-limit";
import { createJobRunner, type OpsAuditResult } from "./job-run";
import { DEFAULT_JOB_ENTRIES, executionFor, type JobRecord, JobTable } from "./job-table";
import type { OpsJobJournal } from "./journal";
import { pendingHandoffs } from "./maintenance";
import { createMaintenanceRuntime } from "./maintenance-runtime";
import { createPolicyResourceClaimer, type OpsResourceClaimer } from "./policy";
import { productionOwnedServices } from "./production-runtime";
import {
  createUnavailableRuntime,
  dispatchOpsOperation,
  type OpsExecutionContext,
  type OpsRuntime,
} from "./runtime";
import { createTerminalSettlement } from "./settlement";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_REPLAY_ENTRIES = 10_000;
const DEFAULT_JOB_RETENTION_MS = 60 * 60_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 15_000;
// The agent checks running maintenances (helper exits, unfinished settles).
const MAINTENANCE_CHECK_INTERVAL_MS = 5_000;

export interface OpsAuditEvent {
  role: OpsRole;
  kind: OpsOperationKind | "invalid";
  resourceId: string;
  result: OpsAuditResult;
  durationMs: number;
  errorClass?: OpsErrorClass;
  /** The lease that refused a busy operation. */
  heldBy?: string;
}

export interface BuildOpsAgentServerOptions {
  artifactTransfers?: ArtifactTransferStore;
  controlInstallation?: ControlInstallation;
  /** The agent's lease store, for the leases data-manager and the host CLI hold. */
  leaseStore?: LeaseStore;
  tokens: Record<OpsRole, string>;
  releaseRecovery?: { ready: boolean; reason?: "recovery_required" };
  resourcePolicy?: OpsResourcePolicy;
  resourceClaimer?: OpsResourceClaimer;
  journal?: OpsJobJournal;
  runtime?: OpsRuntime;
  dispatch?: (
    operation: OpsOperation,
    runtime: OpsRuntime,
    context: OpsExecutionContext,
  ) => Promise<unknown>;
  audit?: (event: OpsAuditEvent) => void;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  bodyLimit?: number;
  operationTimeoutMs?: number;
  maxConcurrency?: number;
  maxReplayEntries?: number;
  maxJobEntries?: number;
  jobRetentionMs?: number;
  claimTimeoutMs?: number;
  /** Dedicated streaming managed-Dawarich collector; absent in minimal/dev agents. */
  dawarichExport?: Omit<DawarichSubjectExportRouteOptions, "apiToken">;
}

export function buildOpsAgentServer(options: BuildOpsAgentServerOptions): FastifyInstance {
  if (new Set(Object.values(options.tokens)).size !== Object.keys(options.tokens).length) {
    throw new Error("Ops agent caller credentials must be distinct");
  }
  const app = Fastify({
    logger: false,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    requestTimeout: 0,
    connectionTimeout: DEFAULT_ADMISSION_TIMEOUT_MS,
  });
  registerOpsIngressRateLimit(app);
  app.addHook("onRequest", async (request, reply) => {
    const streaming =
      (request.routeOptions.config as { artifactTransferBytes?: boolean }).artifactTransferBytes ===
      true;
    // Fastify's injected transport has a minimal socket. Real connections keep
    // their idle timeout; admission also retains its independent destroy timer.
    request.raw.socket.setTimeout?.(streaming ? 5 * 60_000 : DEFAULT_ADMISSION_TIMEOUT_MS);
    if (streaming) return;
    const timer = setTimeout(() => request.raw.destroy(), DEFAULT_ADMISSION_TIMEOUT_MS);
    timer.unref?.();
    const clear = () => {
      clearTimeout(timer);
      request.raw.off("end", clear);
      request.raw.off("aborted", clear);
      reply.raw.off("close", clear);
    };
    request.raw.once("end", clear);
    request.raw.once("aborted", clear);
    reply.raw.once("close", clear);
  });
  if (options.dawarichExport) {
    registerDawarichSubjectExportRoute(app, {
      ...options.dawarichExport,
      apiToken: options.tokens.api,
    });
  }
  if (options.artifactTransfers) {
    registerArtifactTransferRoutes(app, {
      store: options.artifactTransfers,
      apiToken: options.tokens.api,
      admissionsOpen: () =>
        !options.controlInstallation || pendingHandoffs(options.controlInstallation).size === 0,
    });
  }
  const runtime = options.runtime ?? createUnavailableRuntime();
  const dispatch =
    options.dispatch ??
    ((operation, adapter, context) => dispatchOpsOperation(adapter, operation, context));
  const now = options.now ?? (() => new Date());
  const journal: OpsJobJournal =
    options.journal ??
    ({ records: () => [], replace: async () => undefined } satisfies OpsJobJournal);
  let literalProductionRuntime = false;
  try {
    productionOwnedServices(runtime);
    literalProductionRuntime = true;
  } catch {
    /* Generic runtimes retain cache-only ownership. */
  }
  const resourceClaimer =
    options.resourceClaimer ?? createPolicyResourceClaimer(options.resourcePolicy ?? {});
  const settlement = createTerminalSettlement({
    runtime,
    installation: options.controlInstallation,
    artifactTransfers: options.artifactTransfers,
  });
  const maxJobEntries = Math.min(options.maxJobEntries ?? DEFAULT_JOB_ENTRIES, DEFAULT_JOB_ENTRIES);
  const table = new JobTable({
    journal,
    now,
    maxJobEntries,
    jobRetentionMs: Math.max(options.jobRetentionMs ?? DEFAULT_JOB_RETENTION_MS, 72 * 60 * 60_000),
    controlRoots: options.controlInstallation !== undefined,
    settlement,
  });
  const activeStreams = () => options.artifactTransfers?.activeStreams ?? 0;
  /** The configuration maintenance runs its steps through the same claim and
   * dispatch as any operation, each under its own lease child. */
  const maintenanceRuntime = options.controlInstallation
    ? createMaintenanceRuntime({
        runtime,
        installation: options.controlInstallation,
        journal,
        ...(options.now ? { now: options.now } : {}),
        otherActiveOperations: () =>
          table.count(
            (job) =>
              job.operation.kind !== "configurationMaintenance.apply" &&
              configurationHandoffBlocksReplacement(job.operation.kind, job.state),
          ) + activeStreams(),
        async runStepOperation(operation, context, payload) {
          const fingerprint = opsOperationFingerprint(operation);
          const claimed = await resourceClaimer.claim(operation, fingerprint, context.signal, {
            role: "api",
            operationKey: context.execution.operationKey,
            maintenanceStep: true,
          });
          if (!claimed || claimed.fingerprint !== fingerprint)
            throw new OpsContractError("authorization", "Operation resource is not permitted");
          const claim = immutableSnapshot({
            fingerprint: claimed.fingerprint,
            operation: claimed.operation,
            source: claimed.source,
            capability: payload
              ? { ...claimed.capability, trustedConfiguration: payload }
              : claimed.capability,
          });
          if (!context.controlAuthority) throw Error("Maintenance step authority missing");
          await beginControlEffect(context.controlAuthority);
          return parseBoundedOpsResult(
            operation.kind,
            await dispatch(operation, runtime, { ...context, claim }),
          );
        },
      })
    : undefined;
  /** Maintenance kinds run in the maintenance runtime; everything else in the runtime. */
  const dispatchJob = (job: JobRecord, context: OpsExecutionContext) => {
    const operation = job.operation;
    if (maintenanceRuntime && operation.kind === "configurationMaintenance.prepare")
      return maintenanceRuntime.prepare(operation, context);
    if (maintenanceRuntime && operation.kind === "configurationMaintenance.apply") {
      if (job.parent?.issuer !== "api") throw Error("API maintenance parent required");
      return maintenanceRuntime.apply(operation, context, job.parent.apiJobId);
    }
    if (maintenanceRuntime && operation.kind === "configurationMaintenance.settle")
      return maintenanceRuntime.settle(operation, context);
    return dispatch(operation, runtime, context);
  };
  const audit = (
    role: OpsRole,
    kind: OpsOperationKind | "invalid",
    resourceId: string,
    result: OpsAuditResult,
    startedAt: number,
    errorClass?: OpsErrorClass,
  ) => {
    try {
      options.audit?.({
        role,
        kind,
        resourceId,
        result,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(errorClass ? { errorClass } : {}),
      });
    } catch {
      // Audit is deliberately best effort and cannot change protocol state.
    }
  };
  const runner = createJobRunner({
    table,
    runtime,
    dispatchJob,
    reportedFailures: settlement.reportedFailures,
    classify,
    literalProductionRuntime,
    activeStreams,
    audit,
    now,
  });
  const imports = options.controlInstallation
    ? createImportRecovery({
        table,
        runner,
        runtime,
        installation: options.controlInstallation,
        artifactTransfers: options.artifactTransfers,
        resourceClaimer,
        now,
      })
    : undefined;
  let stopControlPrune: (() => Promise<void>) | undefined;
  let maintenanceCheck: ReturnType<typeof setInterval> | undefined;
  app.addHook("preClose", async () => {
    clearInterval(maintenanceCheck);
    await stopControlPrune?.();
  });
  app.addHook("onClose", () => table.close());

  app.setErrorHandler((error, request, reply) => {
    const limited = (error as { statusCode?: number }).statusCode === 429;
    const statusCode = limited
      ? 429
      : (error as { statusCode?: number }).statusCode === 413
        ? 413
        : 400;
    return reply
      .code(statusCode)
      .send(
        redactedOpsError(requestIdFromBody(request.body), limited ? "busy" : "validation", error),
      );
  });
  app.get("/v1/protocol", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    if (!resolveRole(request.headers.authorization, options.tokens))
      return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    return reply.send(opsSuccess(requestId, { versions: [OPS_PROTOCOL_VERSION] }));
  });
  app.get("/health", async () => {
    return {
      ok: true,
      ...(options.releaseRecovery ? { releaseRecovery: options.releaseRecovery } : {}),
    };
  });

  // No replay during restart. Rejoin the retained admissions and own-effect
  // records; absent containment evidence keeps its fence.
  app.addHook("onReady", async () => {
    await options.artifactTransfers
      ?.reconcileTransferStages({ signal: AbortSignal.timeout(30000) })
      .catch(() => undefined);
    // Entries past their retention go before any record is restored, so a
    // record the control prune removed is never looked up for them.
    await table.prune(now().getTime());
    let changed = false;
    for (const job of table.byId.values()) {
      await imports?.reconcile(job);
      if (job.leaseChild) {
        try {
          if (!options.controlInstallation) throw Error("Control trust unavailable");
          changed = (await rejoinBorrowedChild(options.controlInstallation, job)) || changed;
        } catch {
          job.state = "failed";
          job.errorClass = "recovery_required";
          job.result = undefined;
          table.stickyRecoveryRequired.add(job.operationId);
          changed = true;
        }
      }
    }
    for (const job of table.byId.values()) await imports?.reconcileReleased(job);
    if (changed) await table.persist();
    // A maintenance stopped with an attempted step needs recovery; one whose
    // helper runs is watched. Nothing is started again.
    if (maintenanceRuntime) {
      const { maintenance } = maintenanceRuntime;
      await maintenance
        .recover(AbortSignal.timeout(60_000))
        .catch((error) => console.warn("Configuration maintenance recovery failed", error));
      // A settle a restart interrupted ends with its record once that record
      // settled, now or in a later check.
      const completeInterruptedSettles = async () => {
        for (const job of table.byId.values()) {
          const record = maintenance.interruptedSettleResult(job);
          if (!record) continue;
          const timestamp = now();
          Object.assign(job, {
            state: "succeeded",
            result: record,
            errorClass: undefined,
            failureResult: undefined,
            interrupted: undefined,
            terminalAt: timestamp.getTime(),
            updatedAt: timestamp.toISOString(),
          });
          table.stickyRecoveryRequired.delete(job.operationId);
          await table.persist();
        }
      };
      await completeInterruptedSettles().catch((error) =>
        console.warn("Interrupted maintenance settle completion failed", error),
      );
      // A failing check is logged; the agent keeps running and checks again.
      maintenanceCheck = setInterval(
        () =>
          void maintenance
            .tick(AbortSignal.timeout(60_000))
            .then(() => table.withAdmissionLock(completeInterruptedSettles))
            .catch((error) => console.warn("Configuration maintenance check failed", error)),
        MAINTENANCE_CHECK_INTERVAL_MS,
      );
      maintenanceCheck.unref();
    }
    if (options.controlInstallation) {
      const prune = startControlPrune(options.controlInstallation, {
        onError: (error) => console.warn("Control record prune failed", error),
        keep: (operationKey) => table.references(operationKey),
      });
      stopControlPrune = prune.stop;
      await prune.ready;
    }
  });

  /** A data-manager child the agent ran under a borrowed lease: verify a settled
   * one, or adopt it again and settle its lease child. True when its row changed. */
  const rejoinBorrowedChild = async (
    installation: ControlInstallation,
    job: JobRecord,
  ): Promise<boolean> => {
    if (!job.leaseChild) return false;
    const execution = executionFor(job);
    if (job.state === "succeeded") {
      verifyRetainedArtifactTargetSettlement(installation, job.leaseChild, execution);
      return false;
    }
    const admission = inspectControlAdmission(installation, {
      leaseChild: job.leaseChild,
      transportPrincipal: "data-manager",
      kind: job.operation.kind,
      operation: job.operation,
      operationKey: job.operationKey,
      operationFingerprint: execution.operationFingerprint,
      requestedDeadlineAt: execution.deadlineAt,
    });
    const lease = await admission.adopt(execution);
    const authority = restoreAdmittedControlExecution(installation, execution);
    table.leases.set(job.operationId, lease);
    table.authorities.set(job.operationId, authority);
    let changed = false;
    if (job.operation.kind === "transitousLock.approve") {
      const published = await readCommittedCatalogApproval(
        runtime,
        authority,
        lease,
        job.operation,
      );
      if (published) {
        await retainControlEffectReceipt(authority, {
          outcome: "committed",
          publication: "committed",
          receipt: { kind: "ops-result", result: published.result },
        });
        await table.restoreOutcome(job, {
          state: "succeeded",
          result: published.result,
          errorClass: undefined,
          failureResult: undefined,
          terminalAt: published.terminalAt,
          updatedAt: new Date(published.terminalAt).toISOString(),
        });
        changed = true;
      }
    }
    await settleArtifactTargetLeaseChild(
      lease,
      verifyControlEffectSettlement(installation, execution),
    );
    return changed;
  };

  app.post(
    "/v1/operations",
    { bodyLimit: options.bodyLimit ?? CANDIDATE_BODY_LIMIT },
    createAdmission({
      tokens: options.tokens,
      controlInstallation: options.controlInstallation,
      leaseStore: options.leaseStore,
      releaseRecovery: options.releaseRecovery,
      resourceClaimer,
      bodyLimit: options.bodyLimit,
      operationTimeoutMs: options.operationTimeoutMs,
      claimTimeoutMs: options.claimTimeoutMs,
      maxConcurrency: options.maxConcurrency ?? DEFAULT_CONCURRENCY,
      replay: new ReplayCache(options.maxReplayEntries ?? DEFAULT_REPLAY_ENTRIES),
      runtime,
      journal,
      literalProductionRuntime,
      dispatch,
      maintenanceRuntime,
      table,
      runner,
      audit,
      auditBusy: ({ role, kind, resourceId, durationMs, heldBy }) =>
        options.audit?.({
          role,
          kind,
          resourceId,
          result: "denied",
          durationMs,
          errorClass: "busy",
          heldBy,
        }),
      now,
      randomBytes: options.randomBytes ?? nodeRandomBytes,
    }),
  );

  app.get("/v1/operation-keys/:operationKey", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    if (!supportedPeer(request))
      return reply.code(400).send(redactedOpsError(requestId, "unsupported_peer"));
    const operationKey = (request.params as { operationKey?: unknown }).operationKey;
    if (typeof operationKey !== "string" || !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(operationKey)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await table.prune(now().getTime());
    const job = table.byKey.get(`${role}:${operationKey}`);
    if (!job) return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    const fingerprint = request.headers["x-ops-operation-fingerprint"];
    // The lookup names the operation body it would submit; an optional
    // execution fingerprint must match the retained identity as well.
    const bodyFingerprint = request.headers["x-ops-body-fingerprint"];
    if (typeof bodyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(bodyFingerprint))
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    if (bodyFingerprint !== job.operationFingerprint)
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    if (
      fingerprint !== undefined &&
      fingerprint !== job.fingerprint &&
      fingerprint !== bodyFingerprint
    )
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    const requested = request.headers["x-ops-requested-deadline"];
    if (requested !== undefined) {
      const requestedDeadlineAt = Number(requested);
      if (
        typeof requested !== "string" ||
        !Number.isSafeInteger(requestedDeadlineAt) ||
        requestedDeadlineAt < 0
      )
        return reply.code(400).send(redactedOpsError(requestId, "validation"));
      const deadlineAt = Math.min(
        requestedDeadlineAt,
        job.parent?.deadlineAt ?? Infinity,
        job.admittedAt + job.deploymentBudgetMs,
      );
      if (
        executionFingerprint({
          kind: job.operation.kind,
          operationFingerprint: bodyFingerprint,
          deadlineAt,
          ...(job.parent ? { parent: job.parent } : {}),
        }) !== job.fingerprint
      )
        return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    }
    return reply.code(200).send(opsSuccess(requestId, table.status(job)));
  });

  app.get("/v1/operations/:operationId", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    if (!supportedPeer(request))
      return reply.code(400).send(redactedOpsError(requestId, "unsupported_peer"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await table.prune(now().getTime());
    const job = table.byId.get(operationId);
    if (!job || job.role !== role)
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    return reply.code(200).send(opsSuccess(requestId, table.status(job)));
  });

  app.delete("/v1/operations/:operationId", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    if (!supportedPeer(request))
      return reply.code(400).send(redactedOpsError(requestId, "unsupported_peer"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await table.prune(now().getTime());
    const job = table.byId.get(operationId);
    if (!job || job.role !== role)
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    if (request.headers["x-ops-operation-fingerprint"] !== job.fingerprint)
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    if (job.terminalAt !== undefined) {
      await imports?.cancelTerminal(job);
      return reply.code(200).send(opsSuccess(requestId, table.status(job)));
    }
    const controller = table.activeControllers.get(operationId);
    if (!controller) {
      return reply.code(409).send(redactedOpsError(requestId, "conflict"));
    }
    try {
      await table.transition(job, "termination_pending", {
        terminationRequestedAt: job.terminationRequestedAt ?? now().toISOString(),
      });
    } catch {
      table.forceRecoveryRequired(job);
      controller.abort();
      return reply.code(500).send(redactedOpsError(requestId, "runtime"));
    }
    controller.abort();
    const settlement = table.activeSettlements.get(operationId);
    if (settlement) {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settlement,
        new Promise<void>((resolve) => {
          waitTimer = setTimeout(resolve, 5_000);
        }),
      ]).finally(() => {
        if (waitTimer !== undefined) clearTimeout(waitTimer);
      });
    }
    return reply.code(200).send(opsSuccess(requestId, table.status(job)));
  });

  app.get("/v1/operations/:operationId/events", async (request, reply) => {
    const requestId = validRequestId(request.headers["x-ops-request-id"]);
    const role = resolveRole(request.headers.authorization, options.tokens);
    if (!role) return reply.code(401).send(redactedOpsError(requestId, "authentication"));
    const operationId = (request.params as { operationId?: unknown }).operationId;
    const query = request.query as { after?: unknown; limit?: unknown };
    const after = Number(query.after ?? 0);
    const limit = Number(query.limit ?? OPS_MAX_EVENT_BATCH);
    if (
      typeof operationId !== "string" ||
      !OPERATION_ID_PATTERN.test(operationId) ||
      !Number.isInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > OPS_MAX_EVENT_BATCH
    ) {
      return reply.code(400).send(redactedOpsError(requestId, "validation"));
    }
    await table.prune(now().getTime());
    const job = table.byId.get(operationId);
    if (!job || job.role !== role) {
      return reply.code(404).send(redactedOpsError(requestId, "not_found"));
    }
    return reply.code(200).send(opsSuccess(requestId, table.events(job, after, limit)));
  });
  if (options.artifactTransfers) registerArtifactTransferLifecycle(app, options.artifactTransfers);
  return app;
}
