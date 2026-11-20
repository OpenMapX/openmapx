import { createHash, randomUUID } from "node:crypto";
import {
  adminIntegrationReloadResultSchema,
  integrationApplyReceiptSchema,
} from "@openmapx/core/api-contracts";
import { canonicalJson, hardlinkApplySummarySchema } from "@openmapx/core/ops";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { processLogger } from "../process-logger";
import { dbActorId } from "../utils/actor";
import { sanitizeExtensionOutputString, sanitizeLogMetadata } from "../utils/safe-log-fields";
import {
  ActiveMaintenanceConflict,
  isActiveMaintenanceViolation,
} from "./active-maintenance-conflict";
import { checkpointOwnedAdminJob } from "./admin-job-checkpoint";
import { apiKeyedDigest } from "./admin-job-digest";
import {
  AdminJobFailure,
  ConfigurationPrerequisiteFailure,
  JobObservationPending,
  publicAdminJobResult,
} from "./admin-job-failure";
import { cancelAdminJobOperations, resumeAdminJobObservation } from "./admin-job-ops";
import { type OpsProjection, readProjection } from "./admin-job-projection";
import {
  type AdminJobProtocol,
  adminJobObservationDue,
  claimAdminJob,
  hasUnsettledManagedOperation,
  insertOwnedJobLog,
  type JobExecution,
  JobOwnershipLost,
  JobStepAllocationConflict,
  JobStepCapacityExceeded,
  jobCheckpoint,
  jobOwnership,
  mergeJobCheckpoint,
  noUnsettledManagedOperation,
  readAdminJobProtocol,
  readJobExecution,
  renewAdminJobClaim,
  replaceJobCheckpoint,
  splitJobCheckpoint,
} from "./admin-job-state";
import {
  configurationRejection,
  restoreConfigurationRejection,
} from "./configuration-ownership-view";
import { normalizeExtensionInstallPayload } from "./extension-install-payload";
import { hasRetainedExtensionWorkflow } from "./extension-workflow";
import { IntegrationBindingConflict as RetainedBindingConflict } from "./integration-binding-participant";
import { type JobStatusEvent, jobEventBus, TERMINAL_JOB_STATUSES } from "./job-events";
import { ApiOpsError, OpsObservationPending } from "./ops-client";
import { guardedSystemReleasePayloadSchema } from "./platform-configuration-job";
import { retainedMaintenanceJob } from "./retained-maintenance-authorization";
import { type RetainedMaintenanceJobType, retainMaintenanceJob } from "./retained-maintenance-job";
import { appApiRestartCheckpoint } from "./system-update-state";
import {
  completeTrustedConfigurationApply,
  parseTrustedConfigurationApplyOutcome,
} from "./trusted-config-outcome";

type AppApiReplacementOutcome = "applied" | "rolled-back" | "failed";
interface AppApiRuntimeInfo {
  containerId: string;
  imageId: string;
  updateJobId: string | null;
}

export interface JobContext {
  jobId: string;
  jobType?: string;
  execution?: JobExecution;
  observationOnly?: boolean;
  payload: Record<string, unknown>;
  signal: AbortSignal;
  log(
    line: string,
    stream?: "stdout" | "stderr",
    sourceEventId?: string,
    sourceSeq?: number,
  ): Promise<void>;
  setProgress(progress: number): Promise<void>;
  /** Persist restart-safe state before an operation intentionally replaces app-api. */
  checkpoint(
    result: Record<string, unknown>,
    progress?: number,
    admissionKey?: string,
    stepAddress?: string,
    operations?: OpsProjection,
  ): Promise<void>;
  /** Last durable checkpoint loaded with the job and updated after each checkpoint. */
  checkpointResult?: Record<string, unknown> | null;
  /** The runner's protocol state, loaded with the job and updated after each checkpoint. */
  protocol?: AdminJobProtocol;
}

function cancellationReceiptContext(job: typeof adminJob.$inferSelect): JobContext {
  const context: JobContext = {
    jobId: job.id,
    jobType: job.type,
    execution: readJobExecution(job.protocol),
    checkpointResult: jobCheckpoint(job.result, job.protocol),
    protocol: readAdminJobProtocol(job.protocol),
    payload: {},
    signal: new AbortController().signal,
    log: async () => {},
    setProgress: async () => {},
    checkpoint: async (value, _progress, admissionKey, stepAddress, operations) => {
      const saved = await checkpointOwnedAdminJob(
        job.id,
        context.execution,
        value,
        operations ?? readProjection(context.protocol, context.checkpointResult),
        undefined,
        admissionKey,
        stepAddress,
        context.checkpointResult ?? {},
      );
      context.checkpointResult = saved.result;
      context.protocol = saved.protocol;
    },
  };
  return context;
}
type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | undefined>;
function sanitizeExtensionRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    const output = value;
    // Host-owned recovery packets are protocol state, not extension output.
    // Redacting their keys or owner IDs would lose the original identity.
    const retained = Object.fromEntries(
      Object.entries(output).filter(([key]) => key.startsWith("_")),
    );
    const ordinaryOutput = Object.fromEntries(
      Object.entries(output).filter(([key]) => !key.startsWith("_")),
    );
    const serialized = JSON.stringify(ordinaryOutput, (_key, child: unknown) =>
      typeof child === "string" ? sanitizeExtensionOutputString(child) : child,
    );
    if (serialized === undefined) return { value: "[redacted]" };
    const sanitized = sanitizeLogMetadata(JSON.parse(serialized) as unknown);
    Object.assign(sanitized, retained);
    return sanitized;
  } catch {
    return { value: "[redacted]" };
  }
}

const IMMEDIATE_CONFIGURATION_JOB_TYPES = [
  "service.apply",
  "configuration.apply",
  "platform.apply",
  "integration.binding.apply",
  "configuration.migration.apply",
  "credential.import",
] as const;

export const AGENT_RECOVERABLE_ADMIN_JOB_TYPES = [
  "extension.install",
  "extension.remove",
  "standalone.adopt",
  "standalone.remove",
  "standalone.preview",
  "standalone.install",
  "backup.operation",
  "data.operation",
  "service.bulk",
  "service.start",
  "service.stop",
  "service.restart",
  "service.core-restart",
  ...IMMEDIATE_CONFIGURATION_JOB_TYPES,
  "compose.render",
  "compose.start",
  "system.diagnostics",
  "system.update",
  "release.clear",
  "service.images.pull",
  "backup.prune",
  "artifact.validate",
  "artifact.import",
  "artifact.export",
] as const;

/** Routing only, never admission authority. The selected fixed producer must
 * still authenticate the original private packet, owned row/nonce, source and
 * every retained attempt before it can deliver an original continuation. */
function hasRetainedImmediateConfiguration(job: {
  type: string;
  payload: unknown;
  protocol: unknown;
}): boolean {
  const immediate = readAdminJobProtocol(job.protocol).immediate,
    payload = job.payload as Record<string, unknown> | null;
  return (
    IMMEDIATE_CONFIGURATION_JOB_TYPES.some((type) => type === job.type) &&
    typeof immediate?.actorId === "string" &&
    typeof immediate.intentDigest === "string" &&
    /^[a-f0-9]{64}$/.test(immediate.intentDigest) &&
    typeof payload?.operationKey === "string" &&
    /^opk1_[A-Za-z0-9_-]{16,64}$/.test(payload.operationKey)
  );
}
/** Routing only: a queued job that carries a configuration candidate, a
 * service batch or a release runs its handler again on reclaim. Every step it
 * takes is keyed by the job, so a step already sent to the agent returns its
 * original operation, and its candidate continues from the recorded phase. */
function hasRetainedQueuedCoordinator(job: {
  type: string;
  payload: unknown;
  result: unknown;
  protocol: unknown;
}) {
  const payload = job.payload as Record<string, unknown> | null;
  if (!payload) return false;
  const batch = (job.result as Record<string, unknown> | null)?._serviceUpdateBatch;
  if (job.type === "service.bulk" && payload.action === "update" && batch) return true;
  if (job.type === "system.update")
    return guardedSystemReleasePayloadSchema.safeParse(payload).success;
  return readAdminJobProtocol(job.protocol).candidate !== undefined;
}

export class RetainedJobConflict extends Error {}
/** Routing only: the handler checks the original request and its checkpoint before continuing. */
function hasRetainedStandalone(job: { type: string; result: unknown }) {
  const value = job.result as {
    _standalone?: { body?: unknown };
    _standaloneSettled?: unknown;
  } | null;
  return (
    ["standalone.install", "standalone.adopt", "standalone.remove"].includes(job.type) &&
    value?._standaloneSettled !== true &&
    typeof value?._standalone?.body === "string"
  );
}
class JobPersistenceUnavailable extends Error {}

/** Rejoin original extension receipts only; a nested service completion is not
 * evidence that the extension's bookkeeping and transaction settlement finished. */
async function observeExtensionJob(ctx: JobContext): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await resumeAdminJobObservation(ctx);
    const settled = ctx.checkpointResult?._settled as { status?: unknown } | undefined;
    if (settled?.status === "success") return result;
  } catch (error) {
    if (!(error instanceof AdminJobFailure)) throw error;
  }
  throw new JobObservationPending("recovery_required");
}

const PUMP_RETRY_BASE_MS = 1_000;
const PUMP_RETRY_MAX_MS = 30_000;

class AdminJobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly active = new Map<string, AbortController>();
  private readonly logSeq = new Map<string, number>();
  readonly maxConcurrent = 2;

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  async enqueue(
    type: string,
    payload: Record<string, unknown>,
    createdBy?: string | null,
  ): Promise<string> {
    const durablePayload =
      type === "extension.install" ? normalizeExtensionInstallPayload(payload) : payload;
    const id = randomUUID();
    try {
      await db.insert(adminJob).values({
        id,
        type,
        status: "queued",
        payload: durablePayload,
        // Synthetic (loopback) actors have no user row → store null, not a FK violation.
        createdBy: dbActorId(createdBy),
      });
    } catch (error) {
      if (isActiveMaintenanceViolation(error)) throw new ActiveMaintenanceConflict();
      throw error;
    }
    this.schedulePump();
    return id;
  }

  async enqueueMaintenance(
    type: RetainedMaintenanceJobType,
    payload: Record<string, unknown>,
    actorId: string,
    key: string,
    intent?: Record<string, unknown>,
  ): Promise<string> {
    const id = await retainMaintenanceJob(type, payload, actorId, key, intent);
    this.schedulePump();
    return id;
  }

  /** Two fixed standalone producers share actor/key serialization and immutable request identity. */
  async enqueueStandalone(
    type: "standalone.preview" | "standalone.install" | "standalone.adopt" | "standalone.remove",
    payload: Record<string, unknown>,
    actorId: string,
    key: string,
  ): Promise<{ jobId: string; operationId: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key))
      throw new RetainedJobConflict("Invalid mutation key");
    const digest = createHash("sha256")
      .update("openmapx-standalone-request-v1\0")
      .update(canonicalJson({ type, payload, actorId }))
      .digest("hex");
    const accepted = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"standalone:" + actorId + ":" + key},0))`,
      );
      const rows = await tx
        .select()
        .from(adminJob)
        .where(
          and(
            sql`${adminJob.payload}->>'_standaloneActor' = ${actorId}`,
            sql`${adminJob.payload}->>'_standaloneKey' = ${key}`,
          ),
        )
        .limit(2);
      if (rows.length) {
        const old = rows[0]!,
          retained = old.payload as Record<string, unknown>;
        if (
          rows.length !== 1 ||
          old.type !== type ||
          retained._requestDigest !== digest ||
          typeof retained.operationId !== "string"
        )
          throw new RetainedJobConflict("Mutation key belongs to a different standalone request");
        return { jobId: old.id, operationId: retained.operationId };
      }
      const jobId = randomUUID(),
        operationId = randomUUID();
      await tx.insert(adminJob).values({
        id: jobId,
        type,
        status: "queued",
        createdBy: dbActorId(actorId),
        payload: {
          ...payload,
          ownerId: actorId,
          operationId,
          _standaloneActor: actorId,
          _standaloneKey: key,
          _requestDigest: digest,
        },
      });
      return { jobId, operationId };
    });
    this.schedulePump();
    return accepted;
  }

  private async immediate<T>(
    options: {
      type:
        | "configuration.apply"
        | "platform.apply"
        | "service.apply"
        | "compose.start"
        | "integration.binding.apply"
        | "configuration.migration.preview"
        | "configuration.migration.apply"
        | "credential.import";
      actorId?: string;
      operationKey: string;
      intent: unknown;
      signal?: AbortSignal;
      accepted?: (jobId: string) => void;
    },
    run: (
      ctx: JobContext,
    ) => Promise<{ value: T; result: Record<string, unknown>; failed?: boolean }>,
    restore: (result: Record<string, unknown>, jobId: string) => T,
  ): Promise<T> {
    const intentDigest = apiKeyedDigest("immediate-configuration-intent", options.intent);
    const actorId = options.actorId ?? "internal";
    const find = (connection: Pick<typeof db, "select">) =>
      connection
        .select()
        .from(adminJob)
        .where(
          and(
            sql`${adminJob.payload}->>'operationKey' = ${options.operationKey}`,
            sql`${adminJob.protocol}->'immediate'->>'actorId' = ${actorId}`,
          ),
        )
        .limit(2);
    const prior = await find(db);
    const retained = prior.length
      ? prior
      : await db.transaction(async (tx) => {
          const [lock] = await tx.execute<{ held: boolean }>(
            sql`SELECT pg_try_advisory_xact_lock(${0x4f4d58},1) AS held`,
          );
          if (lock?.held !== true) throw new JobObservationPending("recovery_required");
          const current = await find(tx);
          if (current.length) return current;
          const id = randomUUID(),
            execution = { owner: randomUUID(), version: 1 };
          const [created] = await tx
            .insert(adminJob)
            .values({
              id,
              type: options.type,
              status: "running",
              startedAt: new Date(),
              payload: { operationKey: options.operationKey },
              createdBy: dbActorId(options.actorId),
              protocol: {
                execution,
                observationLeaseUntil: new Date(Date.now() + 60000).toISOString(),
                immediate: { actorId, intentDigest },
              },
            })
            .returning();
          if (!created)
            throw new JobPersistenceUnavailable("Immediate administrative job unavailable");
          return [{ ...created, _fresh: true }];
        });
    if (retained.length !== 1) throw new JobObservationPending("recovery_required");
    let job = retained[0]!,
      checkpoint = jobCheckpoint(job.result, job.protocol) ?? {},
      recovering = false;
    if (
      job.type !== options.type ||
      readAdminJobProtocol(job.protocol).immediate?.intentDigest !== intentDigest
    )
      throw new AdminJobFailure("Retained configuration intent conflicts", {
        errorCode: "conflict",
      });
    options.accepted?.(job.id);
    if (!(job as { _fresh?: boolean })._fresh) {
      if (["success", "failed"].includes(job.status)) {
        if (checkpoint._configurationRejection)
          throw restoreConfigurationRejection(checkpoint._configurationRejection);
        return restore(checkpoint, job.id);
      }
      if (
        !["running", "cancel_pending"].includes(job.status) ||
        !IMMEDIATE_CONFIGURATION_JOB_TYPES.some((type) => type === options.type)
      )
        throw new JobObservationPending("recovery_required");
      const claimed = await claimAdminJob(job, {}, true);
      if (!claimed) throw new JobObservationPending("recovery_required");
      job = claimed;
      checkpoint = jobCheckpoint(claimed.result, claimed.protocol) ?? {};
      recovering = true;
    }
    const execution = readJobExecution(job.protocol)!;
    const controller = new AbortController(),
      signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
    this.active.set(job.id, controller);
    let value: T | undefined, failure: unknown;
    const heartbeat = setInterval(() => {
      void renewAdminJobClaim(job.id, execution).catch((error) => controller.abort(error));
    }, 10000);
    heartbeat.unref();
    try {
      await this.executeJob(
        job.id,
        options.type,
        { operationKey: options.operationKey },
        checkpoint,
        job.protocol,
        signal,
        false,
        async (ctx) => {
          if (recovering) {
            return this.resumeImmediateConfiguration(ctx);
          }
          try {
            const result = await run(ctx);
            value = result.value;
            if (result.failed)
              throw new AdminJobFailure("Administrative effect failed", result.result);
            return result.result;
          } catch (error) {
            failure = error;
            const rejection = configurationRejection(error);
            if (rejection)
              await ctx.checkpoint({ ...ctx.checkpointResult, _configurationRejection: rejection });
            throw error;
          }
        },
      );
      const [settled] = await db.select().from(adminJob).where(eq(adminJob.id, job.id));
      if (!settled || !["success", "failed"].includes(settled.status))
        throw new JobObservationPending("recovery_required");
      if (failure && !(value !== undefined && failure instanceof AdminJobFailure)) throw failure;
      return value ?? restore((settled.result ?? {}) as Record<string, unknown>, job.id);
    } finally {
      clearInterval(heartbeat);
      this.active.delete(job.id);
      this.logSeq.delete(job.id);
    }
  }

  /** The same fixed original producer serves a repeated request and startup
   * reconciliation. No registered callback, new intent or latest desired state
   * is used; all authority is reconstructed by its nominal private reader. */
  private async resumeImmediateConfiguration(ctx: JobContext): Promise<Record<string, unknown>> {
    const immediate = readAdminJobProtocol(ctx.protocol).immediate;
    if (
      !immediate ||
      !hasRetainedImmediateConfiguration({
        type: ctx.jobType ?? "",
        payload: ctx.payload,
        protocol: ctx.protocol,
      })
    )
      throw new JobObservationPending("recovery_required");
    const actorId = immediate.actorId,
      operationKey = ctx.payload.operationKey as string,
      { withAdministrativeConfigurationJob, withAdministrativeConfigurationWriter } = await import(
        "./administrative-configuration-writer"
      ),
      { resumeConfigurationCandidate, retainedConfigurationIntegrationIds } = await import(
        "./prospective-configuration"
      ),
      integrationIds = await retainedConfigurationIntegrationIds(ctx, operationKey),
      originalResult = await withAdministrativeConfigurationJob(ctx, () =>
        withAdministrativeConfigurationWriter(
          { actorId, operationKey, integrationIds, signal: ctx.signal },
          () => resumeConfigurationCandidate(),
        ),
      ),
      result = await (
        await import("./transit-credential-recovery")
      ).recoveredTransitCredentialResult(ctx, originalResult);
    const [canceled] = await db
      .select()
      .from(adminJob)
      .where(jobOwnership(ctx.jobId, ctx.execution, ["canceled"]));
    if (canceled) {
      // The producer already recorded its own canceled completion under this
      // nonce. Observe it; generic settlement must not overwrite it with
      // success or failure.
      this.announce(ctx.jobId, "canceled", {
        result: canceled.result as Record<string, unknown> | null,
        finishedAt: canceled.finishedAt?.toISOString(),
      });
      throw new JobOwnershipLost();
    }
    if (
      !completeTrustedConfigurationApply(
        parseTrustedConfigurationApplyOutcome(result.configuration),
      )
    )
      throw new AdminJobFailure("Original configuration did not apply", result);
    if (
      (result.integrationBinding || result.integrationApplication) &&
      integrationApplyReceiptSchema.parse(
        result.integrationBinding ?? result.integrationApplication,
      ).runtime === "failed"
    )
      throw new AdminJobFailure("Binding provider did not activate", result);
    return result;
  }

  runImmediateConfigurationMigrationPreview(input: {
    actorId: string;
    operationKey: string;
    document: import("../../../../packages/core/src/api/contracts/integration-admin/configuration-migration").ConfigurationMigrationDocument;
  }) {
    return this.immediate(
      {
        type: "configuration.migration.preview",
        actorId: input.actorId,
        operationKey: input.operationKey,
        intent: input.document,
      },
      async (ctx) => {
        const value = await (
          await import("./configuration-migration/apply")
        ).runConfigurationMigrationPreview(ctx, input);
        return { value, result: { ...ctx.checkpointResult, migrationPreview: value } };
      },
      (result) => {
        return result.migrationPreview as import("../../../../packages/core/src/api/contracts/integration-admin/configuration-migration").ConfigurationMigrationPreview;
      },
    );
  }
  runImmediateConfigurationMigration(
    input: import("./configuration-migration/apply").MigrationApplicationInput,
  ) {
    return this.immediate(
      {
        type: input.kind === "credentials" ? "credential.import" : "configuration.migration.apply",
        actorId: input.actorId,
        operationKey: input.operationKey,
        intent: {
          previewId: input.previewId,
          fingerprint: input.fingerprint,
          kind: input.kind,
          expectedCurrentRevisionId: input.expectedCurrentRevisionId ?? null,
          platformConfirmations: input.platformAuthorization?.confirmations ?? null,
        },
      },
      (ctx) =>
        import("./configuration-migration/apply").then((m) =>
          m.runConfigurationMigration(ctx, input),
        ),
      (result) => {
        if (result.migration)
          return result.migration as import("./configuration-migration/apply").MigrationResult;
        throw new JobObservationPending("recovery_required");
      },
    );
  }

  /** Desired values remain transient or in the guarded private candidate, never job payload/result. */
  applyImmediateConfiguration(
    options: import("./trusted-config-operations").ApplyTrustedConfigurationOptions,
  ) {
    return this.immediate(
      {
        type: options.followUp === "service-apply" ? "service.apply" : "configuration.apply",
        actorId: options.actorId,
        operationKey: options.operationKey,
        signal: options.signal,
        intent: {
          kind: options.kind,
          serviceId: options.serviceId,
          integrationId: options.integrationId,
          selectedRoots: options.selectedRoots,
          overlay: options.overlay,
          coordinatorMode: options.coordinatorMode,
          followUp: options.followUp,
          ...(Object.hasOwn(options, "expectedCurrentRevisionId")
            ? { expectedCurrentRevisionId: options.expectedCurrentRevisionId }
            : {}),
        },
      },
      async (ctx) => {
        const { applyTrustedConfigurationWithEvidence } = await import(
          "./trusted-configuration-producer"
        );
        const value = await applyTrustedConfigurationWithEvidence({
          ...options,
          ctx,
          signal: ctx.signal,
        });
        return {
          value: { ...value, jobId: ctx.jobId },
          result: { configuration: value.outcome },
          failed: value.outcome.outcome !== "committed" || value.outcome.followUp !== "complete",
        };
      },
      (result, jobId) => {
        if (result.errorCode === "configuration_prerequisite")
          throw new ConfigurationPrerequisiteFailure();
        let outcome = parseTrustedConfigurationApplyOutcome(result.configuration);
        let integrationReload:
          | import("./trusted-config-operations").CapturedIntegrationReloadResult
          | undefined;
        if (options.kind === "integrationConfig.apply" && outcome.outcome === "committed") {
          const retained = result.integrationReload as
            | { state?: string; revisionId?: string; result?: unknown }
            | undefined;
          if (retained?.state === "failed") outcome = { ...outcome, followUp: "failed" };
          else if (retained?.state === "complete" && retained.revisionId === outcome.revisionId) {
            const parsed = adminIntegrationReloadResultSchema
              .pick({ message: true, reloaded: true, enabled: true })
              .parse(retained.result);
            integrationReload = parsed;
          } else throw new JobObservationPending("recovery_required");
        }
        if (options.followUp && outcome.outcome === "committed") {
          const retained = result.serviceCredential as
            | { serviceId?: string; revisionId?: string; followUp?: string }
            | undefined;
          if (
            !retained ||
            retained.serviceId !== options.serviceId ||
            retained.revisionId !== outcome.revisionId ||
            !["complete", "failed"].includes(retained.followUp ?? "")
          )
            throw new JobObservationPending("recovery_required");
          if (retained.followUp === "failed") outcome = { ...outcome, followUp: "failed" };
        }
        return {
          outcome,
          ...(integrationReload ? { integrationReload } : {}),
          jobId,
        };
      },
    );
  }

  startImmediateCompose(options: { actorId: string; operationKey: string; signal?: AbortSignal }) {
    return this.immediate(
      {
        ...options,
        type: "compose.start",
        intent: { action: "compose.start", coordinatorMode: "ensure-running" },
      },
      async (ctx) => {
        const { prepareServiceGeneration } = await import("./service-preparation");
        const { executeAdminJobOperation } = await import("./admin-job-ops");
        const prepared = await prepareServiceGeneration(ctx, "compose-start", {
          coordinatorMode: "ensure-running",
        });
        let ok = true;
        try {
          await executeAdminJobOperation(
            ctx,
            { kind: "stack.start", expectedConfigurationRevisionId: prepared.revisionId },
            "admin-job.compose.start",
          );
        } catch (error) {
          if (error instanceof JobObservationPending || error instanceof OpsObservationPending)
            throw error;
          ok = false;
        }
        const value = { ok, stdout: "", hardlinks: prepared.hardlinks };
        return { value, result: { compose: value }, failed: !ok };
      },
      (result) => {
        const value = result.compose as
          | { ok?: boolean; stdout?: string; hardlinks?: unknown }
          | undefined;
        if (typeof value?.ok !== "boolean" || typeof value.stdout !== "string")
          throw new JobObservationPending("recovery_required");
        return {
          ok: value.ok,
          stdout: value.stdout,
          hardlinks: hardlinkApplySummarySchema.parse(value.hardlinks),
        };
      },
    );
  }

  /** The response observes durable admission only; disconnecting HTTP cannot
   * cancel the original mutation or expose its purpose-proof material. */
  startPlatformConfiguration(
    options: import("./platform-configuration-application").PlatformConfigurationApplicationInput,
  ) {
    const accepted = Promise.withResolvers<{ ok: true; jobId: string }>();
    void this.immediate(
      {
        type: "platform.apply",
        actorId: options.actorId,
        operationKey: options.operationKey,
        intent: {
          purpose: "platform",
          previewFingerprint: options.previewFingerprint,
          expectedCurrentRevisionId: options.expectedCurrentRevisionId,
          confirmations: options.confirmations,
        },
        accepted: (jobId) => accepted.resolve({ ok: true, jobId }),
      },
      async (ctx) => {
        const { runPlatformConfigurationChange } = await import(
          "./platform-configuration-application"
        );
        const value = await runPlatformConfigurationChange(ctx, options);
        return {
          value,
          result: { configuration: value.application },
          failed: !completeTrustedConfigurationApply(value.application),
        };
      },
      (result) => ({ application: parseTrustedConfigurationApplyOutcome(result.configuration) }),
    ).catch(accepted.reject);
    return accepted.promise;
  }

  applyImmediateIntegrationCredential(
    options: import("./integration-credential-application").IntegrationCredentialIntent,
  ) {
    return this.immediate(
      { ...options, type: "configuration.apply", intent: { ...options, operationKey: undefined } },
      async (ctx) => {
        const { runIntegrationCredentialChange } = await import(
          "./integration-credential-application"
        );
        const value = await runIntegrationCredentialChange(ctx, options);
        return {
          value,
          result: { integrationApplication: value },
          failed: value.runtime === "failed",
        };
      },
      (result) => integrationApplyReceiptSchema.parse(result.integrationApplication),
    );
  }

  applyImmediateTransitCredentials(options: {
    actorId: string;
    previewId: string;
    intentFingerprint: string;
    operationKey: string;
    signal?: AbortSignal;
  }) {
    return this.immediate(
      {
        ...options,
        type: "configuration.apply",
        intent: {
          purpose: "transit-credentials",
          previewId: options.previewId,
          intentFingerprint: options.intentFingerprint,
        },
      },
      async (ctx) => {
        const { runTransitCredentialChange } = await import("./transit-credential-application");
        const value = await runTransitCredentialChange(ctx, options);
        return {
          value,
          result: { configuration: value.configuration, transitCredentials: value },
          failed: !completeTrustedConfigurationApply(value.configuration),
        };
      },
      (result) => {
        const value = result.transitCredentials as
          | { credentialsRevision?: unknown; configuration?: unknown }
          | undefined;
        if (
          !value ||
          typeof value.credentialsRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.credentialsRevision)
        )
          throw new JobObservationPending("recovery_required");
        return {
          credentialsRevision: value.credentialsRevision,
          configuration: parseTrustedConfigurationApplyOutcome(value.configuration),
        };
      },
    );
  }

  applyImmediateIntegrationBinding(options: {
    input: import("./integration-binding-participant").IntegrationBindingInput;
    actorId: string;
    operationKey: string;
    signal?: AbortSignal;
  }) {
    return this.immediate(
      { ...options, type: "integration.binding.apply", intent: options.input },
      async (ctx) => {
        const { runBindingChange } = await import("./integration-application");
        try {
          const value = await runBindingChange(ctx, options);
          return {
            value,
            result: { integrationBinding: value },
            failed: value.runtime === "failed",
          };
        } catch (error) {
          const { IntegrationBindingConflict } = await import("./integration-binding-participant");
          if (error instanceof IntegrationBindingConflict)
            await ctx.checkpoint({
              ...ctx.checkpointResult,
              integrationBindingConflict: error.code,
            });
          throw error;
        }
      },
      (result) => {
        if (typeof result.integrationBindingConflict === "string")
          throw new RetainedBindingConflict(result.integrationBindingConflict);
        return integrationApplyReceiptSchema.parse(result.integrationBinding);
      },
    );
  }

  /** Publish a status transition so live viewers see it without polling. */
  private announce(
    jobId: string,
    status: string,
    patch: Omit<JobStatusEvent, "type" | "status"> = {},
  ): void {
    jobEventBus.publish(jobId, { type: "status", status, ...patch });
    if (TERMINAL_JOB_STATUSES.has(status)) jobEventBus.markTerminal(jobId);
  }

  async cancel(jobId: string): Promise<boolean> {
    const canceledAt = new Date();
    const queued = await db
      .update(adminJob)
      .set({ status: "canceled", finishedAt: canceledAt })
      .where(
        and(eq(adminJob.id, jobId), eq(adminJob.status, "queued"), noUnsettledManagedOperation()),
      )
      .returning({ id: adminJob.id });
    if (queued.length > 0) {
      this.announce(jobId, "canceled", { finishedAt: canceledAt.toISOString() });
      return true;
    }

    const [job] = await db
      .update(adminJob)
      .set({
        status: "cancel_pending",
        protocol: sql`${adminJob.protocol} || jsonb_build_object('cancelRequestedAt', coalesce(${adminJob.protocol}->>'cancelRequestedAt', ${new Date().toISOString()}::text))`,
      })
      .where(and(eq(adminJob.id, jobId), inArray(adminJob.status, ["running", "cancel_pending"])))
      .returning();
    if (!job) return false;
    this.announce(jobId, "cancel_pending");
    // Stops only this observer/forward handler. Backend containment is independently verified.
    this.active.get(jobId)?.abort();
    let outcome: Awaited<ReturnType<typeof cancelAdminJobOperations>> = "pending";
    const context = cancellationReceiptContext(job);
    try {
      // A helper the agent's apply left running is stopped before this returns.
      const { abandonAppliedConfigurationMaintenance } = await import(
        "./prospective-configuration"
      );
      await abandonAppliedConfigurationMaintenance(context);
    } catch {
      /* The job's next run sends the same abandonment. */
    }
    try {
      outcome = await cancelAdminJobOperations(
        context.checkpointResult,
        context.protocol,
        undefined,
        {
          context,
          jobId,
          onEvidence: async (evidence) => {
            await db
              .update(adminJob)
              .set(mergeJobCheckpoint(evidence))
              .where(jobOwnership(jobId, readJobExecution(job.protocol), ["cancel_pending"]));
          },
        },
      );
    } catch {
      /* Retain intent. */
    }
    if (outcome !== "canceled") return false;
    const finishedAt = new Date();
    const rows = await db
      .update(adminJob)
      .set({
        status: "canceled",
        finishedAt,
        result: sql`coalesce(${adminJob.result}, '{}'::jsonb) - 'observation'`,
      })
      .where(
        and(
          jobOwnership(jobId, readJobExecution(job.protocol), ["cancel_pending"]),
          noUnsettledManagedOperation(),
        ),
      )
      .returning({ id: adminJob.id, result: adminJob.result });
    if (rows.length === 0) return false;
    this.announce(jobId, "canceled", {
      finishedAt: finishedAt.toISOString(),
      result: rows[0]?.result as Record<string, unknown> | null,
    });
    return true;
  }

  async findActive(type: string): Promise<{ id: string; status: string } | null> {
    const [job] = await db
      .select({ id: adminJob.id, status: adminJob.status })
      .from(adminJob)
      .where(
        and(
          eq(adminJob.type, type),
          inArray(adminJob.status, ["queued", "running", "cancel_pending"]),
        ),
      )
      .orderBy(asc(adminJob.createdAt))
      .limit(1);
    return job ?? null;
  }

  async initialize(
    options: {
      completeRestartedUpdates?: boolean;
      currentAppApiRuntime?: AppApiRuntimeInfo | null;
      resolveReplacementOutcome?: (outcomeFile: string) => Promise<AppApiReplacementOutcome | null>;
      cleanupReplacementOutcome?: (outcomeFile: string) => Promise<void>;
    } = {},
  ): Promise<void> {
    // An application update deliberately replaces app-api as its final step.
    // The server calls this only after it is listening. Finalize only jobs that
    // wrote the explicit pre-restart checkpoint, passed the migration gate,
    // and are now running the exact image that the update pulled. Any other
    // interrupted job retains uncertainty until its original effect is observed.
    const interruptedUpdates = await db
      .select({
        id: adminJob.id,
        result: adminJob.result,
        protocol: adminJob.protocol,
        status: adminJob.status,
      })
      .from(adminJob)
      .where(and(eq(adminJob.status, "running"), eq(adminJob.type, "system.update")));
    const checkpointedUpdates = interruptedUpdates.flatMap((job) => {
      const checkpoint = appApiRestartCheckpoint(job.result);
      return checkpoint ? [{ ...job, checkpoint }] : [];
    });
    for (const candidate of checkpointedUpdates) {
      const claimed = await claimAdminJob({ ...candidate, status: candidate.status ?? "running" });
      if (!claimed) continue;
      const execution = readJobExecution(claimed.protocol);
      const outcome = await (options.resolveReplacementOutcome ?? (async () => null))(
        candidate.checkpoint.outcomeFile,
      );
      const runtime = options.currentAppApiRuntime;
      const migrationsFailed = options.completeRestartedUpdates === false;
      if (!migrationsFailed && (outcome === null || (outcome === "applied" && !runtime))) continue;
      const complete =
        !migrationsFailed &&
        outcome === "applied" &&
        runtime?.imageId === candidate.checkpoint.expectedImageId &&
        runtime.containerId !== candidate.checkpoint.previousContainerId &&
        runtime.updateJobId === candidate.id;
      const error = migrationsFailed
        ? "Update replaced app-api, but database migrations did not complete"
        : outcome === "rolled-back"
          ? "Update failed; the previous app-api image was restored"
          : outcome === "failed"
            ? "Update failed and app-api rollback did not complete"
            : "Update restarted app-api with an unexpected container identity or image";
      const rows = await db
        .update(adminJob)
        .set({
          status: complete ? "success" : "failed",
          finishedAt: new Date(),
          ...(complete
            ? {
                progress: 100,
                result: {
                  ...(claimed.result as Record<string, unknown>),
                  phase: "complete",
                  completedAfterRestart: true,
                },
              }
            : { error }),
        })
        .where(jobOwnership(candidate.id, execution))
        .returning({ id: adminJob.id });
      if (rows.length) await options.cleanupReplacementOutcome?.(candidate.checkpoint.outcomeFile);
    }

    // Startup marks interrupted observers due; no handler is requeued/replayed.
    await db
      .update(adminJob)
      .set({
        result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || jsonb_build_object('observation', jsonb_build_object('state', 'unknown', 'reason', 'transport', 'nextCheckAt', ${new Date().toISOString()}::text))`,
      })
      .where(
        and(
          inArray(adminJob.status, ["running", "cancel_pending"]),
          inArray(adminJob.type, [...AGENT_RECOVERABLE_ADMIN_JOB_TYPES]),
        ),
      );

    // Unknown handlers are never replayed. Interruption alone proves neither
    // failure nor containment, so retain their evidence for operator recovery.
    await db
      .update(adminJob)
      .set({
        result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || jsonb_build_object('observation', jsonb_build_object('state', 'unknown', 'reason', 'recovery_required', 'nextCheckAt', ${new Date().toISOString()}::text))`,
      })
      .where(
        and(
          inArray(adminJob.status, ["running", "cancel_pending"]),
          sql`${adminJob.result}->'observation' IS NULL`,
        ),
      );
    this.pumpStopped = false;
    void this.pump();
  }

  private pumping = false;
  private pumpAgain = false;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private pumpDueAt = 0;
  private pumpFailures = 0;
  private pumpStopped = false;

  /**
   * Keeps at most one pump pending. An earlier request replaces a later one so
   * new work is not held behind a failure backoff; a later request is ignored.
   */
  private schedulePump(delayMs = 0): void {
    if (this.pumpStopped) return;
    const dueAt = Date.now() + delayMs;
    if (this.pumpTimer) {
      if (this.pumpDueAt <= dueAt) return;
      clearTimeout(this.pumpTimer);
    }
    this.pumpDueAt = dueAt;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      void this.pump();
    }, delayMs);
    this.pumpTimer.unref?.();
  }

  /** Cancels any pending pump and refuses new ones until the runner is initialized again. */
  stopPumping(): void {
    this.pumpStopped = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        while (!this.pumpStopped && this.active.size < this.maxConcurrent) {
          const [candidate] = await db
            .select()
            .from(adminJob)
            .where(eq(adminJob.status, "queued"))
            .orderBy(asc(adminJob.createdAt))
            .limit(1);
          if (!candidate) break;
          const job = await claimAdminJob(candidate, { status: "running", startedAt: new Date() });
          if (!job) continue;
          void this.launchJob(job);
        }
      } while (this.pumpAgain && this.active.size < this.maxConcurrent);
      this.pumpFailures = 0;
    } catch (error) {
      this.pumpFailures += 1;
      const delayMs = Math.min(
        PUMP_RETRY_BASE_MS * 2 ** (this.pumpFailures - 1),
        PUMP_RETRY_MAX_MS,
      );
      processLogger.error(
        { component: "job-runner", err: error, retryInMs: delayMs },
        "Could not read or claim queued jobs; retrying",
      );
      this.schedulePump(delayMs);
    } finally {
      this.pumping = false;
    }
  }

  private launchJob(
    row: typeof adminJob.$inferSelect,
    observe = false,
    observationSignal?: AbortSignal,
  ): Promise<void> {
    const job = { ...row, result: jobCheckpoint(row.result, row.protocol) },
      controller = new AbortController(),
      retainedConfiguration =
        observe &&
        (hasRetainedImmediateConfiguration(job) ||
          hasRetainedQueuedCoordinator(job) ||
          retainedMaintenanceJob(job) ||
          hasRetainedStandalone(job) ||
          hasRetainedExtensionWorkflow(job));
    this.active.set(job.id, controller);
    this.logSeq.set(job.id, 0);

    let closed = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const renew = async () => {
      if (closed || controller.signal.aborted) return;
      try {
        await renewAdminJobClaim(job.id, readJobExecution(job.protocol));
      } catch (error) {
        controller.abort(error);
        return;
      }
      if (!closed) {
        heartbeat = setTimeout(() => void renew(), 10_000);
        heartbeat.unref?.();
      }
    };
    if (!observe || retainedConfiguration) {
      heartbeat = setTimeout(() => void renew(), 10_000);
      heartbeat.unref?.();
    }
    return this.executeJob(
      job.id,
      job.type,
      (job.payload as Record<string, unknown>) ?? {},
      (job.result as Record<string, unknown> | null) ?? null,
      job.protocol,
      observe
        ? AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(retainedConfiguration ? 120_000 : 3_000),
            ...(observationSignal ? [observationSignal] : []),
          ])
        : controller.signal,
      observe,
    )
      .finally(() => {
        closed = true;
        clearTimeout(heartbeat);
        this.active.delete(job.id);
        this.logSeq.delete(job.id);
        this.schedulePump();
      })
      .catch((err) => {
        processLogger.error(
          { component: "job-runner", err, jobId: job.id },
          "Unexpected error finalizing a job",
        );
      });
  }

  private async executeJob(
    jobId: string,
    type: string,
    payload: Record<string, unknown>,
    checkpointResult: Record<string, unknown> | null,
    protocol: unknown,
    signal: AbortSignal,
    observe = false,
    immediateHandler?: JobHandler,
  ): Promise<void> {
    const retirement = new AbortController();
    signal = AbortSignal.any([signal, retirement.signal]);
    const lost = (): never => {
      const error = new JobOwnershipLost();
      retirement.abort(error);
      throw error;
    };
    const retainedImmediate =
        observe && hasRetainedImmediateConfiguration({ type, payload, protocol }),
      retainedQueuedCoordinator =
        observe &&
        hasRetainedQueuedCoordinator({ type, payload, result: checkpointResult, protocol }),
      retainedStandalone = observe && hasRetainedStandalone({ type, result: checkpointResult }),
      retainedExtension =
        observe && hasRetainedExtensionWorkflow({ type, result: checkpointResult }),
      retainedMaintenance = observe && retainedMaintenanceJob({ type, payload }),
      retainedConfiguration =
        retainedImmediate ||
        retainedQueuedCoordinator ||
        retainedStandalone ||
        retainedMaintenance ||
        retainedExtension,
      handler = retainedImmediate
        ? (ctx: JobContext) => this.resumeImmediateConfiguration(ctx)
        : retainedQueuedCoordinator ||
            retainedStandalone ||
            retainedMaintenance ||
            retainedExtension
          ? this.handlers.get(type)
          : observe
            ? ["extension.install", "extension.remove"].includes(type)
              ? observeExtensionJob
              : resumeAdminJobObservation
            : (immediateHandler ?? this.handlers.get(type));
    const execution = readJobExecution(protocol);
    let checkpointTail = Promise.resolve();
    let checkpointBaseline = structuredClone((checkpointResult ?? {}) as Record<string, unknown>);
    const sanitizeExtensionOutput = type === "extension.install";
    let executionPayload = payload;
    if (sanitizeExtensionOutput) {
      try {
        executionPayload = normalizeExtensionInstallPayload(payload);
      } catch {
        const finishedAt = new Date();
        const error = "Invalid extension install payload";
        await db
          .update(adminJob)
          .set({ status: "failed", error, finishedAt })
          .where(jobOwnership(jobId, execution));
        this.announce(jobId, "failed", { error, finishedAt: finishedAt.toISOString() });
        return;
      }
    }
    const durableRecord = (value: Record<string, unknown>): Record<string, unknown> =>
      sanitizeExtensionOutput ? sanitizeExtensionRecord(value) : value;
    const durableLine = (value: string): string =>
      sanitizeExtensionOutput ? sanitizeExtensionOutputString(value) : value;

    const ctx: JobContext = {
      jobId,
      jobType: type,
      execution,
      observationOnly: observe && !retainedConfiguration,
      payload: executionPayload,
      signal,
      checkpointResult: checkpointResult === null ? null : durableRecord(checkpointResult),
      protocol: readAdminJobProtocol(protocol),
      log: async (line, stream = "stdout", sourceEventId, sourceSeq) => {
        const localSeq = this.logSeq.get(jobId) ?? 0;
        const seq = sourceSeq ?? localSeq;
        this.logSeq.set(jobId, Math.max(localSeq + 1, seq + 1));
        const id = sourceEventId ?? randomUUID();
        const createdAt = new Date();
        const durableLogLine = durableLine(line);
        signal.throwIfAborted();
        let inserted: boolean;
        try {
          inserted = await insertOwnedJobLog(execution, {
            id,
            jobId,
            seq,
            stream,
            line: durableLogLine,
            createdAt,
          });
        } catch (error) {
          if (error instanceof JobOwnershipLost) lost();
          throw error;
        }
        signal.throwIfAborted();
        if (!inserted) return;
        jobEventBus.publish(jobId, {
          type: "log",
          id,
          seq,
          stream,
          line: durableLogLine,
          createdAt: createdAt.toISOString(),
        });
      },
      setProgress: async (progress) => {
        signal.throwIfAborted();
        const rows = await db
          .update(adminJob)
          .set({ progress })
          .where(jobOwnership(jobId, execution))
          .returning({ id: adminJob.id })
          .catch(() => {
            throw new JobPersistenceUnavailable("Administrative job progress unavailable");
          });
        if (!rows.length) lost();
        jobEventBus.publish(jobId, { type: "progress", progress });
      },
      checkpoint: async (result, progress, admissionKey, stepAddress, operations) => {
        result = durableRecord(result);
        const write = checkpointTail.then(async () => {
          // A job that records agent operations checkpoints them with its result.
          const recorded =
            operations ??
            (ctx.protocol?.operations === undefined
              ? undefined
              : readProjection(ctx.protocol, ctx.checkpointResult));
          if (recorded) {
            if (admissionKey) signal.throwIfAborted();
            try {
              const saved = await checkpointOwnedAdminJob(
                jobId,
                execution,
                result,
                recorded,
                progress,
                admissionKey,
                stepAddress,
                checkpointBaseline,
              );
              ctx.checkpointResult = saved.result;
              ctx.protocol = saved.protocol;
              checkpointBaseline = structuredClone(ctx.checkpointResult);
            } catch (error) {
              if (error instanceof JobStepAllocationConflict) {
                ctx.checkpointResult = error.checkpoint;
                ctx.protocol = error.protocol;
              }
              throw error;
            }
            if (progress !== undefined) jobEventBus.publish(jobId, { type: "progress", progress });
            return;
          }
          if (admissionKey) throw Error("An operation reservation needs its operations");
          signal.throwIfAborted();
          const merged: Record<string, unknown> = { ...ctx.checkpointResult, ...result };
          const rows = await db
            .update(adminJob)
            .set({
              ...replaceJobCheckpoint(merged),
              ...(progress === undefined ? {} : { progress }),
            })
            .where(jobOwnership(jobId, execution))
            .returning({ id: adminJob.id });
          if (!rows.length) lost();
          ctx.checkpointResult = merged;
          ctx.protocol = { ...ctx.protocol, handler: splitJobCheckpoint(merged).handler };
          if (progress !== undefined) jobEventBus.publish(jobId, { type: "progress", progress });
        });
        checkpointTail = write.catch(() => undefined);
        return write.catch((error) => {
          if (
            error instanceof JobOwnershipLost ||
            error instanceof JobStepAllocationConflict ||
            error instanceof JobStepCapacityExceeded ||
            signal.aborted
          )
            throw error;
          throw new JobPersistenceUnavailable("Administrative job checkpoint unavailable");
        });
      },
    };

    if (!observe) this.announce(jobId, "running", { startedAt: new Date().toISOString() });
    const startedAtMs = Date.now();
    const pending = async (reason: OpsObservationPending["reason"]) => {
      try {
        const attempts = Math.min(12, Number(ctx.checkpointResult?._observationAttempts ?? 0) + 1);
        const observationPatch = {
          _observationAttempts: attempts,
          observation: {
            state: "unknown",
            reason,
            nextCheckAt: new Date(
              Date.now() + Math.min(60_000, 5_000 * 2 ** (attempts - 1)),
            ).toISOString(),
          },
        };
        const rows = await db
          .update(adminJob)
          .set(mergeJobCheckpoint(observationPatch, { protocol: { observationLeaseUntil: null } }))
          .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]))
          .returning({ status: adminJob.status, result: adminJob.result });
        if (rows[0])
          this.announce(jobId, rows[0].status, {
            result: rows[0].result as Record<string, unknown> | null,
          });
      } catch {
        throw new JobPersistenceUnavailable("Administrative job persistence unavailable");
      }
    };
    const settle = async (
      status: "success" | "failed",
      result: Record<string, unknown> | null,
      error?: string,
      knownFailure = false,
    ) => {
      if (error !== undefined) error = durableLine(error);
      try {
        await checkpointTail;
        const merged: Record<string, unknown> = { ...ctx.checkpointResult, ...result };
        delete merged.observation;
        const safeMerged = durableRecord(merged);
        if (hasUnsettledManagedOperation(ctx.checkpointResult, ctx.protocol)) {
          if (status === "success" || knownFailure)
            await db
              .update(adminJob)
              .set(
                mergeJobCheckpoint({
                  _settled: { status, result: publicAdminJobResult(safeMerged), error },
                }),
              )
              .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]));
          throw new JobObservationPending("recovery_required");
        }
        const finishedAt = new Date();
        const rows = await db
          .update(adminJob)
          .set({
            status,
            ...mergeJobCheckpoint(
              Object.fromEntries(
                Object.entries(safeMerged).filter(
                  ([key]) => !["_opsLogEvents", "_opsLogBytes"].includes(key),
                ),
              ),
              { dropObservation: true },
            ),
            error: error ?? null,
            finishedAt,
            ...(status === "success" ? { progress: 100 } : {}),
          })
          .where(and(jobOwnership(jobId, execution), noUnsettledManagedOperation()))
          .returning({ id: adminJob.id });
        if (rows.length) {
          this.announce(jobId, status, {
            result: publicAdminJobResult(safeMerged),
            error: error ?? null,
            ...(status === "success" ? { progress: 100 } : {}),
            finishedAt: finishedAt.toISOString(),
          });
        } else {
          // Cancel intent wins; retain late evidence without publishing a terminal event.
          await db
            .update(adminJob)
            .set(
              mergeJobCheckpoint({
                _settled: { status, result: publicAdminJobResult(safeMerged), error },
              }),
            )
            .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]));
          await pending("transport");
        }
      } catch (error) {
        if (error instanceof JobObservationPending) throw error;
        throw new JobPersistenceUnavailable("Administrative job persistence unavailable");
      }
    };
    try {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!handler) throw new Error(`No handler registered for job type "${type}"`);
      if (observe) {
        const [current] = await db
          .select()
          .from(adminJob)
          .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]))
          .limit(1);
        if (!current) return;
        if (current.status === "cancel_pending" && !retainedStandalone) {
          const original = jobCheckpoint(current.result, current.protocol);
          const artifactObservation =
            retainedMaintenance &&
            ["artifact.import", "artifact.validate"].includes(type) &&
            Object.values(readProjection(current.protocol, original).operations).some(
              (operation) =>
                operation.operationId &&
                operation.attempt &&
                operation.fingerprint &&
                operation.deadlineAt &&
                operation.kind ===
                  (type === "artifact.import"
                    ? "artifactTransfer.import"
                    : "artifactTransfer.validate"),
            );
          const outcome = await cancelAdminJobOperations(original, current.protocol, undefined, {
            context: ctx,
            jobId,
            signal,
            onEvidence: async (evidence) => {
              ctx.checkpointResult = { ...ctx.checkpointResult, ...evidence };
              await db
                .update(adminJob)
                .set(mergeJobCheckpoint(evidence))
                .where(jobOwnership(jobId, execution, ["cancel_pending"]));
            },
          }).catch((error) => {
            // Failed artifact canonicals require a durable purpose copy BEFORE
            // ACK. Let only their fixed read-only handler obtain that copy.
            if (artifactObservation && error instanceof JobObservationPending)
              return "pending" as const;
            throw error;
          });
          if (outcome === "pending") {
            if (artifactObservation) ctx.observationOnly = true; // The fixed handler can only rejoin an already-admitted identity.
            if (
              !artifactObservation &&
              (!retainedConfiguration ||
                Object.keys(readProjection(current.protocol, original).operations).length !== 0 ||
                original?._dataExecutions !== undefined)
            ) {
              await pending("transport");
              return;
            }
            // Routing only: before any child admission the generic canceller
            // has no terminal to observe. The producer reads its own candidate
            // before cleanup or canceled publication. The cancel marker still
            // blocks forward admission; neither an empty projection nor this
            // status grants it.
          }
          if (outcome === "canceled") {
            const finishedAt = new Date();
            const rows = await db
              .update(adminJob)
              .set({
                status: "canceled",
                finishedAt,
                result: sql`coalesce(${adminJob.result}, '{}'::jsonb) - 'observation'`,
              })
              .where(
                and(
                  jobOwnership(jobId, execution, ["cancel_pending"]),
                  noUnsettledManagedOperation(),
                ),
              )
              .returning({ id: adminJob.id, result: adminJob.result });
            if (rows.length)
              this.announce(jobId, "canceled", {
                finishedAt: finishedAt.toISOString(),
                result: rows[0]?.result as Record<string, unknown> | null,
              });
            return;
          }
          // Observe the original outcome, including recovered ownership whose
          // verified local candidate cleanup has not finished yet.
          const rows = await db
            .update(adminJob)
            .set({ status: "running" })
            .where(jobOwnership(jobId, execution, ["cancel_pending"]))
            .returning({ id: adminJob.id });
          if (!rows.length) return;
        }
      }
      const result = await handler(ctx);
      // A failed terminal write is uncertainty, not a handler failure. Never
      // turn an accepted successful effect into failed because PostgreSQL failed.
      try {
        await settle("success", result ?? null);
      } catch (error) {
        await pending(error instanceof JobObservationPending ? error.reason : "transport");
      }
    } catch (err) {
      if (err instanceof JobOwnershipLost || err instanceof JobPersistenceUnavailable) return;
      if (err instanceof OpsObservationPending || err instanceof JobObservationPending)
        await pending(err.reason);
      else if (signal.aborted || (err instanceof Error && err.name === "AbortError"))
        await pending("observer_deadline");
      else if (observe && !(err instanceof AdminJobFailure) && !(err instanceof ApiOpsError))
        await pending("transport");
      else {
        try {
          await settle(
            "failed",
            err instanceof AdminJobFailure
              ? err.result
              : err instanceof ApiOpsError
                ? (err.failureResult ?? null)
                : null,
            err instanceof Error ? err.message : "Administrative job failed",
            err instanceof AdminJobFailure || err instanceof ApiOpsError,
          );
        } catch (error) {
          if (error instanceof JobObservationPending) await pending(error.reason);
          else if (!(error instanceof JobPersistenceUnavailable)) throw error;
        }
      }
    } finally {
      jobEventBus.recordHandlerDuration(Date.now() - startedAtMs);
    }
  }

  /** Bounded, database-fenced acquisition; no arbitrary handler is dispatched. */
  async reconcile(options: { limit?: number } = {}, signal?: AbortSignal): Promise<void> {
    const limit = options.limit ?? 32;
    if (!Number.isInteger(limit) || limit < 1 || limit > 32)
      throw new Error("Invalid reconciliation limit");
    const due = await db
      .select()
      .from(adminJob)
      .where(
        and(
          inArray(adminJob.status, ["running", "cancel_pending"]),
          inArray(adminJob.type, [...AGENT_RECOVERABLE_ADMIN_JOB_TYPES]),
          adminJobObservationDue(),
        ),
      )
      .orderBy(asc(adminJob.createdAt))
      .limit(limit);
    for (const job of due) {
      if (signal?.aborted) break;
      if (this.active.has(job.id)) continue;
      const historical = job.status === "failed";
      const claimed = await claimAdminJob(
        job,
        historical ? { status: "running", finishedAt: null } : {},
        !historical,
      );
      if (claimed) await this.launchJob(claimed, true, signal);
    }
  }
}

export const jobRunner = new AdminJobRunner();
