import { createHmac, randomUUID } from "node:crypto";
import {
  adminIntegrationConfigImportedSchema,
  adminIntegrationImportFailureSchema,
} from "@openmapx/core/api-contracts";
import { canonicalJson, hardlinkApplySummarySchema, readOpsTokenFile } from "@openmapx/core/ops";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { dbActorId } from "../utils/actor";
import { checkpointOwnedAdminJob } from "./admin-job-checkpoint";
import {
  AdminJobFailure,
  ConfigurationPrerequisiteFailure,
  JobObservationPending,
  publicAdminJobResult,
} from "./admin-job-failure";
import { cancelAdminJobOperations, resumeAdminJobObservation } from "./admin-job-ops";
import { readProjection } from "./admin-job-projection";
import {
  adminJobObservationDue,
  claimAdminJob,
  hasPendingReceiptDelivery,
  hasUnsettledManagedOperation,
  insertOwnedJobLog,
  type JobExecution,
  JobOwnershipLost,
  JobStepAllocationConflict,
  JobStepCapacityExceeded,
  jobOwnership,
  noPendingReceiptDelivery,
  noUnsettledManagedOperation,
  readJobExecution,
  renewAdminJobClaim,
} from "./admin-job-state";
import { coordinatorLifecycleOperationKey } from "./coordinator-lifecycle";
import { type JobStatusEvent, jobEventBus, TERMINAL_JOB_STATUSES } from "./job-events";
import { ApiOpsError, OpsObservationPending } from "./ops-client";
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
  ): Promise<void>;
  /** Last durable checkpoint loaded with the job and updated after each checkpoint. */
  checkpointResult?: Record<string, unknown> | null;
}

function cancellationReceiptContext(job: typeof adminJob.$inferSelect): JobContext {
  const context: JobContext = {
    jobId: job.id,
    jobType: job.type,
    execution: readJobExecution(job.result),
    checkpointResult: job.result as Record<string, unknown> | null,
    payload: {},
    signal: new AbortController().signal,
    log: async () => {},
    setProgress: async () => {},
    checkpoint: async (value) => {
      context.checkpointResult = await checkpointOwnedAdminJob(
        job.id,
        context.execution,
        value,
        undefined,
        undefined,
        undefined,
        context.checkpointResult ?? {},
      );
    },
  };
  return context;
}
type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | undefined>;

export const AGENT_RECOVERABLE_ADMIN_JOB_TYPES = [
  "backup.operation",
  "data.operation",
  "service.bulk",
  "service.start",
  "service.stop",
  "service.restart",
  "service.core-restart",
  "service.apply",
  "compose.render",
  "configuration.apply",
  "compose.start",
  "integration.config.import",
  "system.diagnostics",
  "system.update",
] as const;

/** Routing only, never admission authority. The selected fixed producer must
 * still authenticate the original private packet, owned row/nonce, source and
 * every retained attempt before it can deliver an original continuation. */
function hasRetainedImmediateConfiguration(job: {
  id: string;
  type: string;
  payload: unknown;
  result: unknown;
}): boolean {
  const result = job.result as Record<string, unknown> | null,
    payload = job.payload as Record<string, unknown> | null;
  return (
    ["service.apply", "configuration.apply", "integration.config.import"].includes(job.type) &&
    result?._immediateJobId === job.id &&
    typeof result._immediateActorId === "string" &&
    typeof result._immediateIntentDigest === "string" &&
    /^[a-f0-9]{64}$/.test(result._immediateIntentDigest) &&
    typeof payload?.operationKey === "string" &&
    /^opk1_[A-Za-z0-9_-]{16,64}$/.test(payload.operationKey) &&
    !!result._configurationCandidate
  );
}
/** Routing only. The fixed producer reauthenticates the original MAC packet,
 * actual owned row/payload and saved decision before any next phase. */
function hasRetainedQueuedCoordinator(job: {
  id: string;
  type: string;
  payload: unknown;
  result: unknown;
}) {
  const payload = job.payload as Record<string, unknown> | null,
    candidate = (job.result as { _configurationCandidate?: { operationKey?: unknown } } | null)
      ?._configurationCandidate;
  if (!payload) return false;
  const batch = (job.result as Record<string, unknown> | null)?._serviceUpdateBatch;
  if (job.type === "service.bulk" && payload.action === "update" && batch) return true; // Routing only; the fixed handler validates the actual owned batch/ACK chain.
  if (!candidate) return false;
  const ordinal =
    job.type === "service.apply" &&
    payload.service === "data-manager" &&
    Object.keys(payload).every((k) => k === "service")
      ? null
      : job.type === "service.bulk" &&
          payload.action === "update" &&
          Array.isArray(payload.serviceIds)
        ? payload.serviceIds.indexOf("data-manager")
        : -1;
  return (
    ordinal !== -1 && candidate.operationKey === coordinatorLifecycleOperationKey(job.id, ordinal)
  );
}
class JobPersistenceUnavailable extends Error {}

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
    const id = randomUUID();
    await db.insert(adminJob).values({
      id,
      type,
      status: "queued",
      payload,
      // Synthetic (loopback) actors have no user row → store null, not a FK violation.
      createdBy: dbActorId(createdBy),
    });
    setTimeout(() => void this.pump(), 0);
    return id;
  }

  private async immediate<T>(
    options: {
      type: "configuration.apply" | "service.apply" | "compose.start" | "integration.config.import";
      actorId?: string;
      operationKey: string;
      intent: unknown;
      signal?: AbortSignal;
    },
    run: (
      ctx: JobContext,
    ) => Promise<{ value: T; result: Record<string, unknown>; failed?: boolean }>,
    restore: (result: Record<string, unknown>) => T,
  ): Promise<T> {
    const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? "");
    const intentDigest = createHmac("sha256", token)
      .update("openmapx-immediate-configuration-intent-v1\0")
      .update(canonicalJson(options.intent))
      .digest("hex");
    const actorId = options.actorId ?? "internal";
    const find = (connection: Pick<typeof db, "select">) =>
      connection
        .select()
        .from(adminJob)
        .where(
          and(
            sql`${adminJob.payload}->>'operationKey' = ${options.operationKey}`,
            sql`${adminJob.result}->>'_immediateActorId' = ${actorId}`,
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
              result: {
                _execution: execution,
                _observationLeaseUntil: new Date(Date.now() + 60000).toISOString(),
                _immediateJobId: id,
                _immediateActorId: actorId,
                _immediateIntentDigest: intentDigest,
              },
            })
            .returning();
          if (!created)
            throw new JobPersistenceUnavailable("Immediate administrative job unavailable");
          return [{ ...created, _fresh: true }];
        });
    if (retained.length !== 1) throw new JobObservationPending("recovery_required");
    let job = retained[0]!,
      checkpoint = (job.result ?? {}) as Record<string, unknown>,
      recovering = false;
    if (job.type !== options.type || checkpoint._immediateIntentDigest !== intentDigest)
      throw new AdminJobFailure("Retained configuration intent conflicts", {
        errorCode: "conflict",
      });
    if (!(job as { _fresh?: boolean })._fresh) {
      if (["success", "failed"].includes(job.status)) return restore(checkpoint);
      if (
        !["running", "cancel_pending"].includes(job.status) ||
        !checkpoint._configurationCandidate ||
        !["service.apply", "configuration.apply", "integration.config.import"].includes(
          options.type,
        )
      )
        throw new JobObservationPending("recovery_required");
      const claimed = await claimAdminJob(job, {}, true);
      if (!claimed) throw new JobObservationPending("recovery_required");
      job = claimed;
      checkpoint = (claimed.result ?? {}) as Record<string, unknown>;
      recovering = true;
    }
    const execution = readJobExecution(checkpoint)!;
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
            throw error;
          }
        },
      );
      const [settled] = await db.select().from(adminJob).where(eq(adminJob.id, job.id));
      if (!settled || !["success", "failed"].includes(settled.status))
        throw new JobObservationPending("recovery_required");
      if (failure && !(value !== undefined && failure instanceof AdminJobFailure)) throw failure;
      return value ?? restore((settled.result ?? {}) as Record<string, unknown>);
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
    if (
      !hasRetainedImmediateConfiguration({
        id: ctx.jobId,
        type: ctx.jobType ?? "",
        payload: ctx.payload,
        result: ctx.checkpointResult,
      })
    )
      throw new JobObservationPending("recovery_required");
    const actorId = ctx.checkpointResult!._immediateActorId as string,
      operationKey = ctx.payload.operationKey as string,
      { withAdministrativeConfigurationJob, withAdministrativeConfigurationWriter } = await import(
        "./administrative-configuration-writer"
      ),
      { resumeRetainedConfigurationCandidate, retainedConfigurationIntegrationIds } = await import(
        "./prospective-configuration"
      ),
      integrationIds = await retainedConfigurationIntegrationIds(ctx, actorId, operationKey),
      result = await withAdministrativeConfigurationJob(ctx, () =>
        withAdministrativeConfigurationWriter(
          { actorId, operationKey, integrationIds, signal: ctx.signal },
          () => resumeRetainedConfigurationCandidate(),
        ),
      );
    const [canceled] = await db
      .select()
      .from(adminJob)
      .where(jobOwnership(ctx.jobId, ctx.execution, ["canceled"]));
    if (canceled) {
      // The fixed producer already published its actual canceled/nonissuance
      // completion under this nonce. Observe it; generic settlement must not
      // overwrite that terminal source with success or failure.
      this.announce(ctx.jobId, "canceled", {
        result: publicAdminJobResult(canceled.result as Record<string, unknown> | null),
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
    return result;
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
          snapshot: options.snapshot,
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
      (result) => {
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
            const parsed = adminIntegrationConfigImportedSchema
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
          ...(typeof result._immediateJobId === "string" ? { jobId: result._immediateJobId } : {}),
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

  importImmediateIntegrationConfiguration(options: {
    body: unknown;
    actorId: string;
    operationKey: string;
    signal?: AbortSignal;
  }) {
    return this.immediate(
      { ...options, type: "integration.config.import", intent: options.body },
      async (ctx) => {
        const { runLegacyIntegrationImport } = await import(
          "./configuration-migration/legacy-integration-import"
        );
        const value = await runLegacyIntegrationImport(ctx, options);
        return { value, result: { integrationImport: value }, failed: !value.ok };
      },
      (result) => {
        // Only exact public, non-secret import evidence is retained/restored.
        if (result.errorCode === "configuration_prerequisite")
          throw new ConfigurationPrerequisiteFailure();
        const success = adminIntegrationConfigImportedSchema.safeParse(result.integrationImport);
        return success.success
          ? success.data
          : adminIntegrationImportFailureSchema.parse(result.integrationImport);
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
        and(
          eq(adminJob.id, jobId),
          eq(adminJob.status, "queued"),
          noPendingReceiptDelivery(),
          noUnsettledManagedOperation(),
        ),
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
        result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || jsonb_build_object('_cancelRequestedAt', coalesce(${adminJob.result}->>'_cancelRequestedAt', ${new Date().toISOString()}::text))`,
      })
      .where(and(eq(adminJob.id, jobId), inArray(adminJob.status, ["running", "cancel_pending"])))
      .returning();
    if (!job) return false;
    this.announce(jobId, "cancel_pending");
    // Stops only this observer/forward handler. Backend containment is independently verified.
    this.active.get(jobId)?.abort();
    let outcome: Awaited<ReturnType<typeof cancelAdminJobOperations>> = "pending";
    try {
      outcome = await cancelAdminJobOperations(job.result, undefined, {
        context: cancellationReceiptContext(job),
        jobId,
        onEvidence: async (evidence) => {
          await db
            .update(adminJob)
            .set({
              result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify(evidence)}::jsonb`,
            })
            .where(jobOwnership(jobId, readJobExecution(job.result), ["cancel_pending"]));
        },
      });
    } catch (error) {
      if (error instanceof JobObservationPending && error.reason === "receipt_delivery") {
        const observation = {
          state: "receipt_delivery",
          reason: "receipt_delivery",
          nextCheckAt: new Date(Date.now() + 5000).toISOString(),
        };
        await db
          .update(adminJob)
          .set({
            result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify({ observation })}::jsonb`,
          })
          .where(jobOwnership(jobId, readJobExecution(job.result), ["cancel_pending"]));
      }
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
          jobOwnership(jobId, readJobExecution(job.result), ["cancel_pending"]),
          noPendingReceiptDelivery(),
          noUnsettledManagedOperation(),
        ),
      )
      .returning({ id: adminJob.id, result: adminJob.result });
    if (rows.length === 0) return false;
    this.announce(jobId, "canceled", {
      finishedAt: finishedAt.toISOString(),
      result: publicAdminJobResult(rows[0]?.result as Record<string, unknown> | null),
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
      .select({ id: adminJob.id, result: adminJob.result, status: adminJob.status })
      .from(adminJob)
      .where(and(eq(adminJob.status, "running"), eq(adminJob.type, "system.update")));
    const checkpointedUpdates = interruptedUpdates.flatMap((job) => {
      const checkpoint = appApiRestartCheckpoint(job.result);
      return checkpoint ? [{ ...job, checkpoint }] : [];
    });
    for (const candidate of checkpointedUpdates) {
      const claimed = await claimAdminJob({ ...candidate, status: candidate.status ?? "running" });
      if (!claimed) continue;
      const execution = readJobExecution(claimed.result);
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
    void this.pump();
  }

  private pumping = false;
  private pumpAgain = false;

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        while (this.active.size < this.maxConcurrent) {
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
    } finally {
      this.pumping = false;
    }
  }

  private launchJob(
    job: typeof adminJob.$inferSelect,
    observe = false,
    observationSignal?: AbortSignal,
  ): Promise<void> {
    const controller = new AbortController(),
      retainedConfiguration =
        observe && (hasRetainedImmediateConfiguration(job) || hasRetainedQueuedCoordinator(job));
    this.active.set(job.id, controller);
    this.logSeq.set(job.id, 0);

    let closed = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const renew = async () => {
      if (closed || controller.signal.aborted) return;
      try {
        await renewAdminJobClaim(job.id, readJobExecution(job.result));
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
        setTimeout(() => void this.pump(), 0);
      })
      .catch((err) => {
        console.error(
          `[job-runner] Unexpected error finalizing job ${job.id}:`,
          err instanceof Error ? err.message : err,
        );
      });
  }

  private async executeJob(
    jobId: string,
    type: string,
    payload: Record<string, unknown>,
    checkpointResult: Record<string, unknown> | null,
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
        observe &&
        hasRetainedImmediateConfiguration({ id: jobId, type, payload, result: checkpointResult }),
      retainedQueuedCoordinator =
        observe &&
        hasRetainedQueuedCoordinator({ id: jobId, type, payload, result: checkpointResult }),
      retainedConfiguration = retainedImmediate || retainedQueuedCoordinator,
      handler = retainedImmediate
        ? (ctx: JobContext) => this.resumeImmediateConfiguration(ctx)
        : retainedQueuedCoordinator
          ? this.handlers.get(type)
          : observe
            ? resumeAdminJobObservation
            : (immediateHandler ?? this.handlers.get(type));
    const execution = readJobExecution(checkpointResult);
    let checkpointTail = Promise.resolve();
    let checkpointBaseline = structuredClone((checkpointResult ?? {}) as Record<string, unknown>);
    const ctx: JobContext = {
      jobId,
      jobType: type,
      execution,
      observationOnly: observe && !retainedConfiguration,
      payload,
      signal,
      checkpointResult,
      log: async (line, stream = "stdout", sourceEventId, sourceSeq) => {
        const localSeq = this.logSeq.get(jobId) ?? 0;
        const seq = sourceSeq ?? localSeq;
        this.logSeq.set(jobId, Math.max(localSeq + 1, seq + 1));
        const id = sourceEventId ?? randomUUID();
        const createdAt = new Date();
        signal.throwIfAborted();
        let inserted: boolean;
        try {
          inserted = await insertOwnedJobLog(execution, {
            id,
            jobId,
            seq,
            stream,
            line,
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
          line,
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
      checkpoint: async (result, progress, admissionKey, stepAddress) => {
        const write = checkpointTail.then(async () => {
          const isV3 = (result.opsProjection as { version?: number } | undefined)?.version === 3;
          if (isV3) {
            if (admissionKey) signal.throwIfAborted();
            try {
              ctx.checkpointResult = await checkpointOwnedAdminJob(
                jobId,
                execution,
                result,
                progress,
                admissionKey,
                stepAddress,
                checkpointBaseline,
              );
              checkpointBaseline = structuredClone(ctx.checkpointResult);
            } catch (error) {
              if (error instanceof JobStepAllocationConflict)
                ctx.checkpointResult = error.checkpoint;
              throw error;
            }
            if (progress !== undefined) jobEventBus.publish(jobId, { type: "progress", progress });
            return;
          }
          signal.throwIfAborted();
          // A handler cannot replace the runner's ownership member.
          const merged: Record<string, unknown> = {
            ...ctx.checkpointResult,
            ...result,
            ...(execution ? { _execution: execution } : {}),
          };
          const rows = await db
            .update(adminJob)
            .set({
              result: sql`${JSON.stringify(merged)}::jsonb || jsonb_build_object('_observationLeaseUntil', ${adminJob.result}->'_observationLeaseUntil')`,
              ...(progress === undefined ? {} : { progress }),
            })
            .where(
              and(
                jobOwnership(jobId, execution),
                ...(admissionKey
                  ? [
                      sql`${adminJob.result}->'opsProjection'->'operations'->${admissionKey} IS NULL`,
                      sql`(${adminJob.result}->'_parentExecution' IS NULL OR ${adminJob.result}->'_parentExecution' = ${JSON.stringify(merged._parentExecution ?? null)}::jsonb)`,
                    ]
                  : []),
              ),
            )
            .returning({ id: adminJob.id });
          if (!rows.length) lost();
          ctx.checkpointResult = merged;
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
    const pending = async (reason: OpsObservationPending["reason"] | "receipt_delivery") => {
      try {
        const attempts = Math.min(12, Number(ctx.checkpointResult?._observationAttempts ?? 0) + 1);
        const observationPatch = {
          _observationAttempts: attempts,
          _observationLeaseUntil: null,
          observation: {
            state: reason === "receipt_delivery" ? "receipt_delivery" : "unknown",
            reason,
            nextCheckAt: new Date(
              Date.now() + Math.min(60_000, 5_000 * 2 ** (attempts - 1)),
            ).toISOString(),
          },
        };
        const rows = await db
          .update(adminJob)
          .set({
            result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify(observationPatch)}::jsonb`,
          })
          .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]))
          .returning({ status: adminJob.status, result: adminJob.result });
        if (rows[0])
          this.announce(jobId, rows[0].status, {
            result: publicAdminJobResult(rows[0].result as Record<string, unknown> | null),
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
      try {
        await checkpointTail;
        const merged: Record<string, unknown> = {
          ...ctx.checkpointResult,
          ...result,
          ...(execution ? { _execution: execution } : {}),
        };
        delete merged.observation;
        if (hasUnsettledManagedOperation(ctx.checkpointResult)) {
          if (status === "success" || knownFailure)
            await db
              .update(adminJob)
              .set({
                result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify({ _settled: { status, result: publicAdminJobResult(merged), error } })}::jsonb`,
              })
              .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]));
          throw new JobObservationPending("recovery_required");
        }
        if (hasPendingReceiptDelivery(ctx.checkpointResult)) {
          await db
            .update(adminJob)
            .set({
              result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify({ _settled: { status, result: publicAdminJobResult(merged), error } })}::jsonb`,
            })
            .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]));
          throw new JobObservationPending("receipt_delivery");
        }
        const finishedAt = new Date();
        const rows = await db
          .update(adminJob)
          .set({
            status,
            result: sql`(coalesce(${adminJob.result}, '{}'::jsonb) - 'observation') || ${JSON.stringify(Object.fromEntries(Object.entries(merged).filter(([key]) => !["opsProjection", "_opsLogEvents", "_opsLogBytes"].includes(key))))}::jsonb`,
            error: error ?? null,
            finishedAt,
            ...(status === "success" ? { progress: 100 } : {}),
          })
          .where(
            and(
              jobOwnership(jobId, execution),
              noPendingReceiptDelivery(),
              noUnsettledManagedOperation(),
            ),
          )
          .returning({ id: adminJob.id });
        if (rows.length) {
          this.announce(jobId, status, {
            result: publicAdminJobResult(merged),
            error: error ?? null,
            ...(status === "success" ? { progress: 100 } : {}),
            finishedAt: finishedAt.toISOString(),
          });
        } else {
          // Cancel intent wins; retain late evidence without publishing a terminal event.
          await db
            .update(adminJob)
            .set({
              result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify({ _settled: { status, result: publicAdminJobResult(merged), error } })}::jsonb`,
            })
            .where(jobOwnership(jobId, execution, ["running", "cancel_pending"]));
          await pending("receipt_delivery");
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
        if (current.status === "cancel_pending") {
          const outcome = await cancelAdminJobOperations(current.result, undefined, {
            context: ctx,
            jobId,
            signal,
            onEvidence: async (evidence) => {
              ctx.checkpointResult = { ...ctx.checkpointResult, ...evidence };
              await db
                .update(adminJob)
                .set({
                  result: sql`coalesce(${adminJob.result}, '{}'::jsonb) || ${JSON.stringify(evidence)}::jsonb`,
                })
                .where(jobOwnership(jobId, execution, ["cancel_pending"]));
            },
          });
          if (outcome === "pending") {
            const original = current.result as Record<string, unknown> | null;
            if (
              !retainedConfiguration ||
              Object.keys(readProjection(original).operations).length !== 0 ||
              original?._dataExecutions !== undefined
            ) {
              await pending("transport");
              return;
            }
            // Routing only: before any child admission the generic canceller
            // has no terminal to observe. The fixed producer must authenticate
            // its private candidate and locked nonissuance state before cleanup
            // or canceled publication. The cancel marker still blocks forward
            // admission; neither an empty projection nor this status grants it.
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
                  noPendingReceiptDelivery(),
                  noUnsettledManagedOperation(),
                ),
              )
              .returning({ id: adminJob.id, result: adminJob.result });
            if (rows.length)
              this.announce(jobId, "canceled", {
                finishedAt: finishedAt.toISOString(),
                result: publicAdminJobResult(rows[0]?.result as Record<string, unknown> | null),
              });
            return;
          }
          // Containment was not performed. Observe the original outcome under this claim.
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
      const claimed = await claimAdminJob(job, {}, true);
      if (claimed) await this.launchJob(claimed, true, signal);
    }
  }
}

export const jobRunner = new AdminJobRunner();
