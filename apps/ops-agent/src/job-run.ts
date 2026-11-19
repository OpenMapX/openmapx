import {
  type ArtifactTargetLease,
  assertArtifactTargetLeaseExecution,
  assertArtifactTargetLeaseForward,
  beginControlEffect,
  commitFeedProxyValidationFailure,
  markFeedProxyReloadAttempted,
  retainConfigurationPreEffectRefusal,
} from "@openmapx/core/build-artifacts";
import {
  type ConfigurationApplyResult,
  configurationApplyResultSchema,
  type DataWorkflowReceipt,
  isTrustedConfigurationApplyOperation,
  OPS_KIND_POLICIES,
  OPS_MAX_EVENT_MESSAGE_BYTES,
  type OpsErrorClass,
  type OpsFailureResult,
  type OpsOperationKind,
  type OpsRole,
  opsFailureResultSchema,
  PROCESS_OUTPUT_TRUNCATED,
  parseBoundedOpsResult,
  processDiagnosticsSchema,
  type ServiceBatchResult,
} from "@openmapx/core/ops";
import { configurationHandoffBlocksReplacement } from "./configuration-handoff";
import { isReportedProcessFailure } from "./docker-runtime";
import { executionFor, type JobRecord, type JobTable } from "./job-table";
import { assertManagedCliConfigurationPreflight } from "./maintenance-source";
import { safeProcessDiagnostic } from "./process-output";
import { type OpsExecutionContext, OpsExecutionFailure, type OpsRuntime } from "./runtime";
import {
  beforeEffect,
  beginsEffectAtDispatch,
  completesAfterCancel,
  LEASED_KINDS,
  refusesBeforeEffectOnError,
} from "./settlement";

export type OpsAuditResult =
  | "success"
  | "denied"
  | "error"
  | "timeout"
  | "terminated"
  | "late_completion";
export type OpsAudit = (
  role: OpsRole,
  kind: OpsOperationKind | "invalid",
  resourceId: string,
  result: OpsAuditResult,
  startedAt: number,
  errorClass?: OpsErrorClass,
) => void;

function truncateUtf8(message: string, maxBytes: number): string {
  let bytes = 0;
  let bounded = "";
  for (const character of message) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bounded += character;
    bytes += size;
  }
  return bounded;
}

/**
 * Runs admitted jobs: builds the context a runtime handler gets, begins the
 * root's effect, dispatches, and records the terminal outcome through the job
 * table. A failed terminal write leaves the job recovery_required.
 */
export function createJobRunner(options: {
  table: JobTable;
  runtime: OpsRuntime;
  dispatchJob: (job: JobRecord, context: OpsExecutionContext) => Promise<unknown>;
  reportedFailures: Set<string>;
  classify: (error: unknown) => { errorClass: OpsErrorClass };
  literalProductionRuntime: boolean;
  activeStreams: () => number;
  audit: OpsAudit;
  now: () => Date;
}) {
  const { table, now, audit } = options;

  /** Other operations a configuration handoff waits for. */
  const otherActiveOperations = (operationId?: string) =>
    table.count(
      (other) =>
        other.operationId !== operationId &&
        configurationHandoffBlocksReplacement(other.operation.kind, other.state),
    ) + options.activeStreams();

  const checkpoint = async (job: JobRecord, evidence: OpsFailureResult) => {
    await table.withAdmissionLock(async () => {
      job.progressResult = evidence;
      job.updatedAt = now().toISOString();
      await table.persist();
    });
  };

  const emitLog = (job: JobRecord, stream: "stdout" | "stderr", message: string) => {
    const boundedMessage = truncateUtf8(
      safeProcessDiagnostic(message),
      OPS_MAX_EVENT_MESSAGE_BYTES,
    );
    const tail = [
      ...(job.diagnostics?.tail ?? []).filter(
        (entry) => entry.message !== PROCESS_OUTPUT_TRUNCATED,
      ),
      { stream, message: boundedMessage },
    ];
    let truncated =
      (job.diagnostics?.truncated ?? false) || boundedMessage === PROCESS_OUTPUT_TRUNCATED;
    while (
      tail.length > 255 ||
      Buffer.byteLength(JSON.stringify({ tail, truncated })) > 16 * 1024 - 128
    ) {
      const stdoutBytes = tail
        .filter((entry) => entry.stream === "stdout")
        .reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0);
      const stderrBytes = tail
        .filter((entry) => entry.stream === "stderr")
        .reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0);
      tail.splice(
        tail.findIndex(
          (entry) => entry.stream === (stdoutBytes >= stderrBytes ? "stdout" : "stderr"),
        ),
        1,
      );
      truncated = true;
    }
    job.diagnostics = {
      tail: [
        ...(truncated ? [{ stream: "stderr" as const, message: PROCESS_OUTPUT_TRUNCATED }] : []),
        ...tail,
      ],
      truncated,
    };
    table.scheduleDiagnostics(job);
    job.cursor += 1;
    table.pushEvent(job, { cursor: job.cursor, type: "log", stream, message: boundedMessage });
  };

  const contextFor = (
    job: JobRecord,
    signal: AbortSignal,
    claim: OpsExecutionContext["claim"],
  ): OpsExecutionContext => {
    const lease = table.leases.get(job.operationId);
    return {
      signal,
      claim,
      execution: executionFor(job),
      artifactLease: lease?.mode === "borrowed" ? lease : undefined,
      ownedTargetLease: lease?.mode === "owner" ? lease : undefined,
      controlAuthority: table.authorities.get(job.operationId),
      ...(job.operation.kind === "data.update"
        ? {
            ownDataFinalizationLease(lease: ArtifactTargetLease) {
              if (table.leases.has(job.operationId))
                throw Error("Original Full Update lease already retained");
              assertArtifactTargetLeaseExecution(lease, executionFor(job));
              table.leases.set(job.operationId, lease);
            },
            async checkpointDataWorkflow(dataWorkflow: DataWorkflowReceipt) {
              await checkpoint(
                job,
                opsFailureResultSchema.parse({ ...job.progressResult, dataWorkflow }),
              );
            },
          }
        : {}),
      ...(job.operation.kind === "feedProxy.validateAndReload"
        ? {
            async commitFeedProxyValidationFailure(input: {
              candidateDigest: string;
              validationExitCode: number;
              completionDigest: string;
            }) {
              const authority = table.authorities.get(job.operationId);
              if (!authority) throw Error("Original validation authority missing");
              commitFeedProxyValidationFailure(authority, input);
            },
            async markFeedProxyReloadAttempted() {
              const authority = table.authorities.get(job.operationId);
              if (!authority) throw Error("Original validation authority missing");
              markFeedProxyReloadAttempted(authority);
            },
          }
        : {}),
      otherActiveOperations: () => otherActiveOperations(job.operationId),
      ...(job.operation.kind === "services.buildAll"
        ? {
            checkpointServiceBatch: async (serviceBatch: ServiceBatchResult) => {
              const evidence = opsFailureResultSchema.parse({
                ...job.progressResult,
                serviceBatch,
              });
              if (
                Buffer.byteLength(JSON.stringify(evidence)) >
                OPS_KIND_POLICIES[job.operation.kind].maxResultBytes
              )
                throw Error("Service batch evidence exceeds budget");
              await checkpoint(job, evidence);
            },
          }
        : {}),
      emitLog: (stream, message) => emitLog(job, stream, message),
    };
  };

  /** Records the terminal outcome of a returned run. */
  const settleResult = async (
    job: JobRecord,
    rawResult: unknown,
    startedAt: number,
    timedOut: boolean,
  ): Promise<void> => {
    const terminalAt = now().getTime();
    if (isTrustedConfigurationApplyOperation(job.operation)) {
      // Public status remains running until the terminal event is published.
      const result = configurationApplyResultSchema.parse(
        parseBoundedOpsResult(job.operation.kind, rawResult),
      );
      table.configurationResultsSettling.add(job.operationId);
      try {
        await table.transition(job, "succeeded", { result, errorClass: undefined, terminalAt });
      } catch (error) {
        throw Object.assign(new Error("Configuration result write failed"), {
          cause: error,
          configurationEvidence: result,
        });
      }
      audit(
        job.role,
        job.operation.kind,
        job.resourceId,
        timedOut ? "late_completion" : "success",
        startedAt,
      );
    } else if (table.stickyRecoveryRequired.has(job.operationId)) {
      await table.transition(job, "failed", {
        result: undefined,
        errorClass: "recovery_required",
        terminalAt,
      });
      audit(job.role, job.operation.kind, job.resourceId, "error", startedAt, "recovery_required");
    } else if (
      (timedOut || job.state === "termination_pending") &&
      completesAfterCancel(job, rawResult)
    ) {
      // These fixed leaf handlers return only after their host call
      // settles. Cancellation cannot erase a validated commit receipt
      // from an already-started call; no new forward phase is allowed.
      const result = parseBoundedOpsResult(job.operation.kind, rawResult);
      await table.transition(job, "succeeded", { result, errorClass: undefined, terminalAt });
      audit(job.role, job.operation.kind, job.resourceId, "late_completion", startedAt);
    } else if (timedOut) {
      await table.transition(job, "timed_out", { errorClass: "timeout", terminalAt });
      audit(job.role, job.operation.kind, job.resourceId, "late_completion", startedAt, "timeout");
    } else if (job.state === "termination_pending") {
      await table.transition(job, "failed", {
        result: undefined,
        errorClass: "runtime",
        terminalAt,
      });
      audit(job.role, job.operation.kind, job.resourceId, "terminated", startedAt, "runtime");
    } else {
      const result = parseBoundedOpsResult(job.operation.kind, rawResult);
      await table.transition(job, "succeeded", { result, errorClass: undefined, terminalAt });
      audit(job.role, job.operation.kind, job.resourceId, "success", startedAt);
    }
  };

  /** Records the terminal outcome of a run that threw. */
  const settleError = async (
    job: JobRecord,
    error: unknown,
    startedAt: number,
    timedOut: boolean,
  ) => {
    if (table.stickyRecoveryRequired.has(job.operationId)) {
      await table.transition(job, "failed", {
        result: undefined,
        errorClass: "recovery_required",
        terminalAt: now().getTime(),
      });
      audit(job.role, job.operation.kind, job.resourceId, "error", startedAt, "recovery_required");
      return;
    }
    const errorClass = timedOut ? ("timeout" as const) : options.classify(error).errorClass;
    if (
      !timedOut &&
      LEASED_KINDS.has(job.operation.kind) &&
      (isReportedProcessFailure(error) ||
        isReportedProcessFailure((error as { cause?: unknown } | undefined)?.cause))
    )
      options.reportedFailures.add(job.operationId);
    let failureResult: OpsFailureResult | undefined;
    if (error instanceof OpsExecutionFailure) {
      const safe = opsFailureResultSchema.parse(error.failureResult);
      if (safe.diagnostics)
        safe.diagnostics = {
          ...safe.diagnostics,
          tail: safe.diagnostics.tail.map((entry) => ({
            ...entry,
            message: safeProcessDiagnostic(entry.message),
          })),
        };
      failureResult = opsFailureResultSchema.parse(safe);
      if (
        Buffer.byteLength(JSON.stringify(failureResult)) >
        OPS_KIND_POLICIES[job.operation.kind].maxResultBytes
      )
        failureResult = undefined;
      if (failureResult?.diagnostics)
        job.diagnostics = processDiagnosticsSchema.parse(failureResult.diagnostics);
    }
    await table.transition(job, timedOut ? "timed_out" : "failed", {
      result: undefined,
      failureResult,
      errorClass,
      terminalAt: now().getTime(),
    });
    audit(
      job.role,
      job.operation.kind,
      job.resourceId,
      timedOut ? "terminated" : "error",
      startedAt,
      errorClass,
    );
  };

  /** The fallback when a terminal write failed: failed, or recovery_required in memory. */
  const settleFallback = async (job: JobRecord) => {
    await table
      .transition(job, "failed", {
        result: undefined,
        errorClass: "runtime",
        terminalAt: now().getTime(),
      })
      .catch(() => table.forceRecoveryRequired(job));
  };

  /** Starts an admitted job; resolves once it runs, its settlement continues alone. */
  const run = async (job: JobRecord, startedAt: number, claim: OpsExecutionContext["claim"]) => {
    try {
      await table.transition(job, "running");
    } catch (error) {
      table.forceRecoveryRequired(job);
      audit(job.role, job.operation.kind, job.resourceId, "error", startedAt, "runtime");
      table.active -= 1;
      throw error;
    }
    const controller = new AbortController();
    table.activeControllers.set(job.operationId, controller);
    const timeoutMs = Math.max(0, (job.deadlineAt ?? now().getTime()) - now().getTime());
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void table
        .transition(job, "termination_pending", {
          terminationRequestedAt: job.terminationRequestedAt ?? now().toISOString(),
        })
        .then(
          () => controller.abort(),
          () => controller.abort(),
        );
    }, timeoutMs);
    const settlement = Promise.resolve()
      .then(async () => {
        if ((job.deadlineAt ?? 0) <= now().getTime()) {
          timedOut = true;
          throw new OpsExecutionFailure("timeout", {});
        }
        const authority = table.authorities.get(job.operationId);
        if (authority) {
          const lease = table.leases.get(job.operationId);
          if (lease) assertArtifactTargetLeaseForward(lease);
          if (options.literalProductionRuntime) {
            try {
              await assertManagedCliConfigurationPreflight(
                options.runtime,
                job.operation,
                contextFor(job, controller.signal, claim),
              );
            } catch (error) {
              if (
                error instanceof OpsExecutionFailure &&
                error.errorClass === "configuration_prerequisite"
              )
                retainConfigurationPreEffectRefusal(authority);
              throw error;
            }
          }
          beforeEffect(job, authority, claim);
          if (beginsEffectAtDispatch(job.operation)) beginControlEffect(authority);
        }
        try {
          return await options.dispatchJob(job, contextFor(job, controller.signal, claim));
        } catch (error) {
          if (authority && refusesBeforeEffectOnError(job.operation)) {
            try {
              // The nominal producer checks the original started cell and all
              // children. A begun stage cannot be relabeled as unissued.
              retainConfigurationPreEffectRefusal(authority);
            } catch {
              // Existing begun/unknown evidence remains fenced.
            }
          }
          throw error;
        }
      })
      .then(
        async (rawResult) => {
          clearTimeout(timer);
          try {
            await settleResult(job, rawResult, startedAt, timedOut);
          } catch (error) {
            const configurationEvidence = (
              error as { configurationEvidence?: ConfigurationApplyResult }
            ).configurationEvidence;
            if (configurationEvidence) {
              // Journal failure must not erase observed pointer-commit evidence.
              // Retain it in memory; restart may still require reconciliation if
              // this final record cannot be made durable. Do not release an
              // uncheckpointed claim or retry the configuration mutation.
              const retained = { ...configurationEvidence, cleanupFailed: true };
              await table
                .transition(job, "succeeded", {
                  result: retained,
                  errorClass: undefined,
                  terminalAt: now().getTime(),
                })
                .catch(() => {
                  job.state = "succeeded";
                  job.result = retained;
                  job.errorClass = undefined;
                  job.terminalAt = now().getTime();
                });
            } else {
              await settleFallback(job);
              audit(job.role, job.operation.kind, job.resourceId, "error", startedAt, "runtime");
            }
          } finally {
            try {
              if (
                table.configurationResultsSettling.delete(job.operationId) &&
                job.state === "succeeded"
              )
                table.pushState(job, "succeeded");
            } finally {
              // The slot is returned even when terminal bookkeeping throws.
              table.activeControllers.delete(job.operationId);
              table.active -= 1;
            }
          }
        },
        async (error) => {
          clearTimeout(timer);
          try {
            await settleError(job, error, startedAt, timedOut);
          } catch {
            await settleFallback(job);
          } finally {
            // The slot is returned even when terminal bookkeeping throws.
            table.activeControllers.delete(job.operationId);
            table.active -= 1;
          }
        },
      );
    table.activeSettlements.set(job.operationId, settlement);
    void settlement.then(
      () => table.activeSettlements.delete(job.operationId),
      () => table.activeSettlements.delete(job.operationId),
    );
  };

  return { contextFor, run, otherActiveOperations };
}
export type JobRunner = ReturnType<typeof createJobRunner>;
