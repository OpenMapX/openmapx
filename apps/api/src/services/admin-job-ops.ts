import { envString } from "@openmapx/core/server-env";
import {
  type OpsProjection,
  type ProjectedOperation,
  readProjection,
} from "./admin-job-projection";

export { readProjection } from "./admin-job-projection";

import { createHash, randomUUID } from "node:crypto";
import {
  type CoordinatorPullSubmission,
  canonicalJson,
  configurationApplyResultSchema,
  controlTerminalReceiptDigest,
  coordinatorPullSubmissionSchema,
  createControlRootOperationKey,
  type OpsJobStatus,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
  type OpsSubmitResult,
  opsKindRequiresControlAuthority,
  opsOperationSchema,
  parseOpsJobStatus,
  readOpsTokenFile,
  signApiRetentionProof,
} from "@openmapx/core/ops";
import { cancelAdminDataChildren } from "./admin-data-children";
import { AdminJobFailure, JobObservationPending } from "./admin-job-failure";
import {
  type ApiPreparedRoot,
  issueApiJobChildAssertion,
  prepareApiJobChildAttempt,
  prepareApiJobRoot,
} from "./admin-job-parent";
import {
  ADMIN_JOB_LOG_LIMITS,
  JobOwnershipLost,
  JobStepAllocationConflict,
} from "./admin-job-state";
import { readArtifactPurposeObservation } from "./artifact-purpose-observation";
import { configurationMaintenanceProjectedStepOrigin } from "./configuration-maintenance-step-records";
import {
  assertCoordinatorPullIntent,
  type CoordinatorLifecycleIntent,
  claimCoordinatorPullDelivery,
} from "./coordinator-lifecycle";
import type { JobContext } from "./job-runner";
import {
  type ApiOpsClient,
  ApiOpsError,
  createApiOpsClient,
  createDurableOpsKey,
  followOpsEvents,
  OpsObservationPending,
  submitOpsOperationWithRecovery,
  waitForOpsResult,
} from "./ops-client";

const ADMIN_EVENT_LIMIT = ADMIN_JOB_LOG_LIMITS.events;
const ADMIN_EVENT_BYTE_LIMIT = ADMIN_JOB_LOG_LIMITS.bytes;
const CANCEL_POLL_ATTEMPTS = 8;
const ADMISSION_REFUSALS = new Set([
  "authentication",
  "authorization",
  "validation",
  "expired",
  "future",
  "busy",
  "not_wired",
  "host_update_required",
  "control_upgrade_required",
  "recovery_required",
]);

export interface ExecuteAdminJobOperationOptions {
  client?: ApiOpsClient;
  operationKey?: string;
  pollIntervalMs?: number;
  durableIdentity?: string;
  preparedRoot?: ApiPreparedRoot;
}

async function persistProjection(
  context: JobContext,
  projection: OpsProjection,
  admissionKey?: string,
  stepAddress?: string,
  parentExecution?: Record<string, unknown>,
): Promise<void> {
  const value = {
    ...(context.checkpointResult ?? {}),
    ...(parentExecution ? { _parentExecution: parentExecution } : {}),
    opsProjection: projection,
  };
  if (admissionKey) await context.checkpoint(value, undefined, admissionKey, stepAddress);
  else await context.checkpoint(value);
  if (!context.execution) context.checkpointResult = value;
}

/** Delivery is a durable observation obligation, independent of the worker's abort signal. */
export async function ensureAdminJobReceiptDelivery(
  context: JobContext,
  projection: OpsProjection,
  projected: ProjectedOperation,
  client: ApiOpsClient,
  status?: OpsJobStatus,
): Promise<void> {
  if (
    projected.phase === "refused" ||
    projected.phase === "unissued" ||
    projection.version !== 3 ||
    !projected.attempt ||
    !Object.values(projection.steps).some((s) => s.operationKey === projected.operationKey) ||
    !opsKindRequiresControlAuthority(projected.kind)
  )
    return;
  const canonical = status ?? projected.receiptDelivery?.terminalReceipt;
  if (
    canonical &&
    canonical.state !== "succeeded" &&
    ["artifactTransfer.import", "artifactTransfer.validate"].includes(projected.kind)
  ) {
    if (
      !projected.operationId ||
      !projected.fingerprint ||
      !projected.deadlineAt ||
      !readArtifactPurposeObservation(context.checkpointResult, projected.operation, {
        executionId: projected.operationId,
        operationKey: projected.operationKey,
        fingerprint: projected.fingerprint,
        executionDeadlineAt: new Date(projected.deadlineAt).toISOString(),
      })
    )
      throw new JobObservationPending("recovery_required");
  }
  try {
    if (!projected.receiptDelivery) {
      if (!status || !context.execution) throw new JobObservationPending("recovery_required");
      const { diagnostics: _diagnostics, ...safe } = parseOpsJobStatus(status);
      if (
        safe.operationKey !== projected.operationKey ||
        safe.operationId !== projected.operationId ||
        safe.fingerprint !== projected.fingerprint ||
        safe.deadlineAt !== projected.deadlineAt ||
        safe.kind !== projected.kind ||
        Buffer.byteLength(JSON.stringify(safe)) > 128 * 1024
      )
        throw new JobObservationPending("recovery_required");
      projected.receiptDelivery = {
        state: "pending",
        terminalCopyId: randomUUID(),
        checkpointOwnerVersion: context.execution.version,
        terminalDigest: controlTerminalReceiptDigest(safe),
        terminalReceipt: safe,
      };
      await persistProjection(context, projection);
      // Only the confirmed CAS result is authority to mint the proof.
      const retained = readProjection(context.checkpointResult).operations[projected.operationKey]
        ?.receiptDelivery;
      if (!retained || retained.terminalCopyId !== projected.receiptDelivery.terminalCopyId)
        throw new JobObservationPending("receipt_delivery");
      projected.receiptDelivery = retained;
    }
    const delivery = projected.receiptDelivery;
    if (delivery.state === "confirmed") return;
    const fingerprint = projected.fingerprint;
    if (!fingerprint) throw new JobObservationPending("recovery_required");
    const token = await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", ""));
    const proof = signApiRetentionProof(token, {
      version: 1,
      apiJobId: projected.attempt.apiJobId,
      originalApiOwnerVersion: projected.attempt.apiOwnerVersion,
      attemptId: projected.attempt.attemptId,
      checkpointOwnerVersion: delivery.checkpointOwnerVersion,
      terminalCopyId: delivery.terminalCopyId,
      operationKey: projected.operationKey,
      fingerprint: fingerprint,
      terminalDigest: delivery.terminalDigest,
    });
    const ownerControl =
      projected.operation?.kind === "configurationMaintenance.decide" ||
      projected.operation?.kind === "configurationMaintenance.settle"
        ? projected.operation
        : undefined;
    if (
      ["configurationMaintenance.decide", "configurationMaintenance.settle"].includes(
        projected.kind,
      ) &&
      !ownerControl
    )
      throw new JobObservationPending("recovery_required");
    const frozenOrigin =
      projected.operation &&
      "maintenanceId" in projected.operation &&
      projected.operation.maintenanceId &&
      !ownerControl &&
      context.checkpointResult?._configurationMaintenanceSteps
        ? configurationMaintenanceProjectedStepOrigin(
            context.checkpointResult,
            projected.operationKey,
            projected.operation,
            projected.attempt,
          )
        : undefined;
    const response = await client.execute(
      {
        kind: "controlRetention.acknowledge",
        originRootKey: ownerControl?.prepareOperationKey ?? frozenOrigin ?? projected.operationKey,
        operationKey: projected.operationKey,
        fingerprint: fingerprint,
        terminalDigest: delivery.terminalDigest,
        proof,
      },
      { signal: AbortSignal.timeout(15_000) },
    );
    if (response.execution !== "sync" || response.value.acknowledged !== true)
      throw Error("Receipt acknowledgement unavailable");
    projected.receiptDelivery = { ...delivery, state: "confirmed" };
    await persistProjection(context, projection);
    if (
      readProjection(context.checkpointResult).operations[projected.operationKey]?.receiptDelivery
        ?.state !== "confirmed"
    )
      throw Error("Receipt confirmation checkpoint unavailable");
  } catch (error) {
    if (
      error instanceof JobOwnershipLost ||
      (error instanceof JobObservationPending && error.reason === "recovery_required")
    )
      throw error;
    throw new JobObservationPending("receipt_delivery");
  }
}
/**
 * Submit a typed administrative effect and mirror its bounded durable event
 * stream into the existing API job log. The agent journal remains the source
 * of truth: an API-side log failure or disconnect never cancels the effect.
 */
export async function executeAdminJobOperation<K extends OpsOperationKind>(
  context: JobContext,
  operation: Extract<OpsOperation, { kind: K }>,
  keyNamespace: string,
  options: ExecuteAdminJobOperationOptions = {},
): Promise<OpsResultFor<K>> {
  const client = options.client ?? createApiOpsClient();
  const durableIdentity = options.durableIdentity
    ? `${context.jobId}:${options.durableIdentity}`
    : context.jobId;
  const stepAddress = options.operationKey ?? createDurableOpsKey(keyNamespace, durableIdentity);
  let projection = readProjection(context.checkpointResult);
  const retainedKey = projection.steps[stepAddress]?.operationKey ?? stepAddress;
  let restored = projection.operations[retainedKey];
  if (restored?.phase === "prepared" || restored?.phase === "unissued")
    throw new JobObservationPending("recovery_required");
  if (restored && restored.kind !== operation.kind)
    throw new JobObservationPending("invalid_identity");
  if (restored)
    return observeOperation(context, projection, restored, client, options, false) as Promise<
      OpsResultFor<K>
    >;
  if (context.observationOnly) throw new JobObservationPending("recovery_required");
  if (!context.execution) throw Error("Fresh managed operation requires a durable job owner");
  const exactOperation = opsOperationSchema.parse(operation);
  const root = options.preparedRoot ?? prepareApiJobRoot(context, exactOperation.kind, stepAddress);
  const expectedNonce = createHash("sha256")
    .update("openmapx-api-control-root-nonce-v1\0")
    .update(canonicalJson({ jobId: context.jobId, stepAddress }))
    .digest()
    .subarray(0, 16);
  if (
    root.operationKey !==
    createControlRootOperationKey({ notAfter: root.requestedDeadlineAt, nonce: expectedNonce })
  ) {
    const { assertOwnedConfigurationMaintenanceStep } = await import(
      "./configuration-maintenance-step"
    );
    await assertOwnedConfigurationMaintenanceStep(context, exactOperation, root.operationKey, root);
  }
  const operationKey = root.operationKey,
    attempt = prepareApiJobChildAttempt(context, exactOperation, operationKey, root);
  if (!attempt) throw Error("Fresh managed operation requires a durable job attempt");
  const projected: ProjectedOperation = {
    kind: exactOperation.kind,
    operationKey,
    operation: exactOperation,
    attempt,
    phase: "admitting",
    cursor: 0,
    events: 0,
    bytes: 0,
    truncated: false,
    terminal: false,
  };
  projection = {
    ...projection,
    version: 3,
    steps: {
      ...projection.steps,
      [stepAddress]: { operationKey, requestedDeadlineAt: attempt.requestedDeadlineAt },
    },
    operations: { ...projection.operations, [operationKey]: projected },
  };
  const parentExecution = {
    operationKey: attempt.parentOperationKey,
    fingerprint: attempt.parentFingerprint,
    deadlineAt: attempt.parentDeadlineAt,
  };
  // Submit only the candidate entry. The locked current row determines both
  // map capacities and any winning mapping, even for a full stale snapshot.
  const reservation = {
    ...projection,
    steps: { [stepAddress]: { operationKey, requestedDeadlineAt: attempt.requestedDeadlineAt } },
    operations: { [operationKey]: projected },
  };
  try {
    await persistProjection(context, reservation, operationKey, stepAddress, parentExecution);
  } catch (error) {
    if (!(error instanceof JobStepAllocationConflict)) throw error;
    projection = readProjection(context.checkpointResult);
    restored = projection.operations[projection.steps[stepAddress]?.operationKey ?? stepAddress];
    if (!restored || restored.kind !== operation.kind)
      throw new JobObservationPending("recovery_required");
    return observeOperation(context, projection, restored, client, options, false) as Promise<
      OpsResultFor<K>
    >;
  }
  projection = readProjection(context.checkpointResult);
  const admitted = projection.operations[operationKey];
  if (!admitted) throw new JobObservationPending("recovery_required");
  return observeOperation(context, projection, admitted, client, options, true) as Promise<
    OpsResultFor<K>
  >;
}

/** Finite preallocation for the nominal coordinator Update only. No dispatch
 * occurs; the original attempt is checkpointed before the candidate is sealed. */
export async function reserveCoordinatorPullSubmission(
  context: JobContext,
  intent: CoordinatorLifecycleIntent,
  expectedConfigurationRevisionId: string,
  parent: ApiPreparedRoot["parent"],
): Promise<CoordinatorPullSubmission> {
  const fixed = await assertCoordinatorPullIntent(intent, context),
    stepAddress = createDurableOpsKey(
      "configuration.coordinator-pull",
      `${context.jobId}:${fixed.originalOrdinal}`,
    ),
    operation = {
      kind: "service.pull" as const,
      serviceId: "data-manager" as const,
      expectedConfigurationRevisionId,
      candidateId: fixed.candidateId,
    },
    root = prepareApiJobRoot(
      { ...context, checkpointResult: { ...context.checkpointResult, _parentExecution: parent } },
      "service.pull",
      stepAddress,
    ),
    attempt = prepareApiJobChildAttempt(context, operation, root.operationKey, root);
  if (!attempt) throw Error("Original coordinator job owner required");
  const submission = coordinatorPullSubmissionSchema.parse({
      version: 1,
      requestVersion: 2,
      expectedExecutor: "ops-agent",
      expectedPrincipal: "api",
      stepAddress,
      operation,
      operationKey: root.operationKey,
      operationFingerprint: attempt.childOperationFingerprint,
      requestedDeadlineAt: attempt.requestedDeadlineAt,
      attempt,
    }),
    entry: ProjectedOperation = {
      kind: "service.pull",
      operationKey: root.operationKey,
      operation,
      attempt,
      phase: "prepared",
      cursor: 0,
      events: 0,
      bytes: 0,
      truncated: false,
      terminal: false,
    },
    projection = readProjection(context.checkpointResult);
  await persistProjection(
    context,
    {
      ...projection,
      version: 3,
      steps: {
        [stepAddress]: {
          operationKey: root.operationKey,
          requestedDeadlineAt: root.requestedDeadlineAt,
        },
      },
      operations: { [root.operationKey]: entry },
    },
    root.operationKey,
    stepAddress,
    parent,
  );
  const retained = readProjection(context.checkpointResult).operations[root.operationKey];
  if (!retained || canonicalJson(retained.attempt) !== canonicalJson(attempt))
    throw new JobObservationPending("recovery_required");
  return submission;
}
/** Only the fixed original MAC candidate/owned-row CAS may release a prepared
 * normal pull for its first delivery, including after API owner reclaim. */
export async function deliverCoordinatorPullSubmission(context: JobContext, candidateId: string) {
  const original = await claimCoordinatorPullDelivery(context, candidateId),
    projection = readProjection(context.checkpointResult),
    entry = projection.operations[original.operationKey];
  if (!entry) throw new JobObservationPending("recovery_required");
  return observeOperation(context, projection, entry, createApiOpsClient(), {}, original.fresh);
}

export function prepareAdminJobOperationRoot(
  ctx: JobContext,
  kind: OpsOperationKind,
  stepAddress: string,
): ApiPreparedRoot {
  const p = readProjection(ctx.checkpointResult);
  if (p.operations[p.steps[stepAddress]?.operationKey ?? stepAddress])
    throw new JobObservationPending("recovery_required");
  return prepareApiJobRoot(ctx, kind, stepAddress);
}
export function retainedAdminJobOperation(ctx: JobContext, key: string): OpsOperation | undefined {
  const p = readProjection(ctx.checkpointResult);
  return p.operations[p.steps[key]?.operationKey ?? key]?.operation;
}
export function hasRetainedAdminJobOperation(ctx: JobContext, key: string): boolean {
  const p = readProjection(ctx.checkpointResult);
  return p.operations[p.steps[key]?.operationKey ?? key] !== undefined;
}
export async function observeRetainedAdminJobOperation(
  ctx: JobContext,
  key: string,
): Promise<unknown> {
  const projection = readProjection(ctx.checkpointResult);
  const retained = projection.operations[projection.steps[key]?.operationKey ?? key];
  if (!retained) throw new JobObservationPending("recovery_required");
  return observeOperation(ctx, projection, retained, createApiOpsClient(), {});
}

async function observeOperation(
  context: JobContext,
  projection: OpsProjection,
  projected: ProjectedOperation,
  client: ApiOpsClient,
  options: ExecuteAdminJobOperationOptions,
  fresh = false,
): Promise<unknown> {
  if (projected.terminal)
    await ensureAdminJobReceiptDelivery(context, projection, projected, client);
  if (!projected.terminal) context.signal.throwIfAborted();
  let terminalStatus: OpsJobStatus | undefined;
  const observer = new AbortController();
  const signal = AbortSignal.any([context.signal, observer.signal]);
  let ownershipLost: JobOwnershipLost | undefined;
  const retireIfLost = (error: unknown) => {
    if (error instanceof JobOwnershipLost) {
      ownershipLost = error;
      observer.abort(error);
      throw error;
    }
  };
  const identity = {
    kind: projected.kind,
    operationKey: projected.operationKey,
    operationId: projected.operationId,
  };
  if (projected.attempt && projected.attempt.apiJobId !== context.jobId)
    throw new OpsObservationPending(identity, "invalid_identity");
  if (projected.terminal && (projected.result !== undefined || projected.errorClass)) {
    if (projected.errorClass)
      throw new ApiOpsError(
        projected.errorClass as ApiOpsError["errorClass"],
        projected.failureResult,
      );
    return projected.result;
  }
  const safeCheckpoint = async () => {
    try {
      await persistProjection(context, projection);
    } catch (error) {
      retireIfLost(error);
      /* Ordinary projection failure never cancels effects. */
    }
  };
  try {
    let admission: OpsSubmitResult<OpsOperationKind>;
    if (projected.operationId) {
      // A retained ID is not authority to adopt another operation's logs.
      // Authenticate and match its complete identity before opening the stream.
      const status = await client
        .status(projected.kind, projected.operationId, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
        })
        .catch(() => {
          throw new OpsObservationPending(
            identity,
            context.signal.aborted ? "observer_deadline" : "unavailable",
          );
        });
      if (
        status.kind !== projected.kind ||
        status.operationId !== projected.operationId ||
        status.operationKey !== projected.operationKey ||
        (projected.fingerprint !== undefined && status.fingerprint !== projected.fingerprint) ||
        (projected.deadlineAt !== undefined && status.deadlineAt !== projected.deadlineAt)
      )
        throw new OpsObservationPending(identity, "invalid_identity");
      admission = {
        execution: "async" as const,
        kind: projected.kind,
        operationId: projected.operationId,
        operationKey: projected.operationKey,
        state: "queued" as const,
        fingerprint: projected.fingerprint,
        deadlineAt: projected.deadlineAt,
      };
    } else {
      if (!projected.operation) throw new OpsObservationPending(identity, "invalid_identity");
      admission = await submitOpsOperationWithRecovery(
        client,
        projected.operation,
        projected.operationKey,
        {
          signal,
          admissionAlreadyAttempted: !fresh,
          recoveryTimeoutMs: 2_000,
          ...(projected.attempt
            ? { execution: { requestedDeadlineAt: projected.attempt.requestedDeadlineAt } }
            : {}),
          ...(fresh && projected.attempt
            ? { parentAssertion: await issueApiJobChildAssertion(projected.attempt) }
            : {}),
        },
      );
      if (admission.execution === "sync") {
        projected.result = admission.value;
        projected.terminal = true;
        projected.phase = "terminal";
        await persistProjection(context, projection);
        return admission.value;
      }
      projected.operationId = admission.operationId;
      projected.fingerprint = admission.fingerprint;
      projected.deadlineAt = admission.deadlineAt;
      projected.phase = "observing";
      // If this checkpoint fails, the admitting intent still supports lookup-only recovery.
      try {
        await persistProjection(context, projection);
      } catch (error) {
        retireIfLost(error);
        throw new OpsObservationPending(identity, "transport");
      }
    }
    const ownEventBase = { events: projected.events, bytes: projected.bytes };
    const mirrorBase = { events: projection.eventTotal, bytes: projection.byteTotal };
    const isMapped = Object.values(projection.steps).some(
      (step) => step.operationKey === projected.operationKey,
    );
    const updateMirror = (state: {
      cursor: number;
      events: number;
      bytes: number;
      truncated: boolean;
    }) =>
      Object.assign(
        projected,
        state,
        isMapped
          ? {
              events: ownEventBase.events + Math.max(0, state.events - mirrorBase.events),
              bytes: ownEventBase.bytes + Math.max(0, state.bytes - mirrorBase.bytes),
            }
          : {},
      );
    const mirrorController = new AbortController();
    const mirrorSignal = AbortSignal.any([signal, mirrorController.signal]);
    const mirror = projected.mirrorStopped
      ? Promise.resolve()
      : followOpsEvents(client, admission.operationId, {
          signal: mirrorSignal,
          maxEvents: ADMIN_EVENT_LIMIT,
          maxBytes: ADMIN_EVENT_BYTE_LIMIT,
          pollIntervalMs: options.pollIntervalMs,
          cancelOnExit: false,
          initial: {
            cursor: projected.cursor,
            events: projection.eventTotal,
            bytes: projection.byteTotal,
            truncated: projection.truncated,
          },
          onLog: async (stream, message, cursor) => {
            try {
              await context.log(message, stream, `ops:${admission.operationId}:${cursor}`, cursor);
            } catch (error) {
              retireIfLost(error);
              projected.truncated = true;
              projection.truncated = true;
            }
          },
          onProgress: async (state) => {
            updateMirror(state);
            projection.eventTotal = state.events;
            projection.byteTotal = state.bytes;
            projection.truncated ||= state.truncated;
            await safeCheckpoint();
          },
        })
          .then(async (state) => {
            if (state) {
              updateMirror(state);
              projected.mirrorStopped = true;
              projection.truncated ||= state.truncated;
              await safeCheckpoint();
            }
          })
          .catch((error) => {
            // Observe this rejection immediately; propagate after joining the
            // result observer so it cannot become an unhandled rejection.
            if (error instanceof JobOwnershipLost) {
              ownershipLost = error;
              observer.abort(error);
            }
          });
    const observed = await waitForOpsResult(client, projected.kind, admission, {
      signal,
      pollIntervalMs: options.pollIntervalMs,
      ...(context.observationOnly ? { timeoutMs: 2_000 } : {}),
      onStatus: (status) => {
        if (["succeeded", "failed", "timed_out"].includes(status.state)) terminalStatus = status;
        if (status.diagnostics) projected.diagnostics = status.diagnostics;
        if (status.failureResult) projected.failureResult = status.failureResult;
      },
    }).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    mirrorController.abort();
    await mirror;
    if (ownershipLost) throw ownershipLost;
    if (!observed.ok) throw observed.error;
    const result = observed.result;
    projected.result = result;
    const configuration = configurationApplyResultSchema.safeParse(result);
    if (configuration.success)
      context.checkpointResult = {
        ...context.checkpointResult,
        configuration: configuration.data,
      };
    projected.terminal = true;
    projected.phase = "terminal";
    delete projected.outcome;
    await ensureAdminJobReceiptDelivery(context, projection, projected, client, terminalStatus);
    return result;
  } catch (error) {
    if (error instanceof ApiOpsError) {
      if (
        projected.kind === "configurationMaintenance.settle" &&
        terminalStatus?.errorClass === "recovery_required"
      ) {
        // The original accepted verification intent has NO private canonical
        // completion. Preserve observation-only recovery; never copy/ACK it as
        // a terminal outcome or admit another request/body/budget.
        projected.outcome = "unknown";
        projected.phase = "observing";
        projected.terminal = false;
        delete projected.errorClass;
        delete projected.failureResult;
        throw new JobObservationPending("recovery_required");
      }
      if (!terminalStatus) {
        if (!projected.operationId && fresh && ADMISSION_REFUSALS.has(error.errorClass)) {
          projected.phase = "refused";
          projected.terminal = true;
          projected.errorClass = error.errorClass;
          delete projected.outcome;
          await persistProjection(context, projection);
          throw error;
        }
        projected.outcome = "unknown";
        throw new JobObservationPending("recovery_required");
      }
      projected.failureResult = error.failureResult;
      projected.errorClass = error.errorClass;
      projected.terminal = true;
      projected.phase = "terminal";
      context.checkpointResult = {
        ...context.checkpointResult,
        ...error.failureResult,
        ...(error.errorClass === "host_update_required" ? { errorCode: error.errorClass } : {}),
      };
      await ensureAdminJobReceiptDelivery(context, projection, projected, client, terminalStatus);
    } else if (!(error instanceof JobObservationPending && error.reason === "receipt_delivery")) {
      projected.outcome = "unknown";
    }
    throw error;
  } finally {
    context.checkpointResult = {
      ...context.checkpointResult,
      ...projected.failureResult,
      ...(projection.truncated ? { logTruncated: true } : {}),
    };
    if (projected.diagnostics)
      context.checkpointResult = {
        ...context.checkpointResult,
        diagnostics: projected.diagnostics,
      };
    if (!ownershipLost) await safeCheckpoint();
  }
}

/** Reconciliation observes retained attempts only. It never invokes the original handler. */
export async function resumeAdminJobObservation(
  ctx: JobContext,
): Promise<Record<string, unknown> | undefined> {
  const projection = readProjection(ctx.checkpointResult);
  const entries = Object.values(projection.operations);
  const firstEntry = entries[0];
  if (!firstEntry) throw new JobObservationPending("recovery_required");
  let client: ApiOpsClient;
  try {
    client = createApiOpsClient();
  } catch {
    throw new JobObservationPending("transport");
  }
  let failure: ApiOpsError | undefined;
  for (const operation of entries) {
    try {
      await observeOperation(ctx, projection, operation, client, {});
    } catch (error) {
      if (!(error instanceof ApiOpsError)) throw error;
      failure ??= error;
    }
  }
  const evidence = { ...ctx.checkpointResult };
  if (hasUnsettledHardlinks(evidence)) throw new JobObservationPending("recovery_required");
  if (failure)
    throw new AdminJobFailure(failure.message, { ...evidence, ...failure.failureResult });
  const settled = evidence._settled as
    | { status: string; result?: Record<string, unknown>; error?: string }
    | undefined;
  if (settled?.status === "failed")
    throw new AdminJobFailure(settled.error ?? "Operation failed", {
      ...evidence,
      ...settled.result,
    });
  if (settled?.status === "success") return { ...evidence, ...settled.result };
  const completion = evidence._completion as
    | { operationKey?: string; result?: Record<string, unknown> }
    | undefined;
  const completionAddress = completion?.operationKey;
  if (
    completionAddress &&
    entries.some(
      (entry) =>
        entry.operationKey ===
          (projection.steps[completionAddress]?.operationKey ?? completionAddress) &&
        entry.terminal,
    )
  )
    return { ...evidence, ...completion.result };
  // Single-effect jobs have a complete retained receipt. Multi-step workflows
  // require the original completion checkpoint; observing a render is not apply.
  if (
    [
      "service.stop",
      "service.restart",
      "service.core-restart",
      "backup.operation",
      "data.operation",
      "system.diagnostics",
    ].includes(ctx.jobType ?? "") &&
    entries.length === 1
  )
    return { ...evidence, ...((entries[0]?.result as Record<string, unknown>) ?? {}) };
  throw new OpsObservationPending(
    {
      kind: firstEntry.kind,
      operationKey: firstEntry.operationKey,
      operationId: firstEntry.operationId,
    },
    "recovery_required",
  );
}

function hasUnsettledHardlinks(result: unknown): boolean {
  const attempts = (result as { _hardlinkAttempts?: Record<string, { phase?: string }> } | null)
    ?._hardlinkAttempts;
  return !!attempts && Object.values(attempts).some((attempt) => attempt?.phase !== "complete");
}

export interface CancelAdminJobOperationsOptions {
  context?: JobContext;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  jobId?: string;
  onEvidence?: (evidence: Record<string, unknown>) => Promise<void>;
}

/** Per-operation reconciliation outcome. */
type AdminOperationCancellation = "succeeded" | "contained" | "already_terminal";

/**
 * Aggregate cancellation outcome.
 *
 * - `canceled` — at least one operation was contained by this request.
 * - `completed` — every operation had already succeeded.
 * - `already_terminal` — every operation is terminal, none was contained by
 *   this request, and at least one had already failed or timed out.
 * - `pending` — at least one operation is still not terminal.
 */
export type AdminJobCancellationOutcome = "canceled" | "completed" | "already_terminal" | "pending";

export async function cancelAdminJobOperations(
  result: unknown,
  client: Pick<ApiOpsClient, "cancel" | "status" | "lookup"> = createApiOpsClient(),
  options: CancelAdminJobOperationsOptions = {},
): Promise<AdminJobCancellationOutcome> {
  const projection = readProjection(result);
  const pending = Object.values(projection.operations);
  const backend = await cancelAdminDataChildren(result, pending, options);
  // Reconcile every known root even when a backend sibling remains pending.
  // No agent projection is not proof that no registered backend remains.
  // Known descendants have been explicitly canceled/observed above; missing
  // original parent containment still keeps the application pending.
  if (pending.length === 0) return "pending";
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10_000) {
    throw new Error("Invalid cancellation poll interval");
  }

  const cancellationSent = new Set<string>();
  // Send exact retained cancellation to all roots before any held sibling can
  // cause observation to return pending. Adoption is checkpointed first.
  if (pending.length > 1 || backend !== "none")
    for (const operation of pending) {
      if (operation.phase === "refused" || operation.terminal || options.signal?.aborted) continue;
      try {
        const status = operation.operationId
          ? await client.status(operation.kind, operation.operationId, {
              signal: options.signal
                ? AbortSignal.any([options.signal, AbortSignal.timeout(2000)])
                : AbortSignal.timeout(2000),
            })
          : operation.operation
            ? await client.lookup(operation.operation, operation.operationKey, {
                signal: AbortSignal.timeout(2000),
                ...(operation.attempt
                  ? { execution: { requestedDeadlineAt: operation.attempt.requestedDeadlineAt } }
                  : {}),
              })
            : undefined;
        if (
          !status ||
          status.kind !== operation.kind ||
          status.operationKey !== operation.operationKey ||
          (operation.operationId && status.operationId !== operation.operationId) ||
          (operation.fingerprint && status.fingerprint !== operation.fingerprint) ||
          (operation.deadlineAt && status.deadlineAt !== operation.deadlineAt)
        )
          continue;
        operation.operationId = status.operationId;
        operation.fingerprint = status.fingerprint;
        operation.deadlineAt = status.deadlineAt;
        if (options.context) await persistProjection(options.context, projection);
        if (!["succeeded", "failed", "timed_out"].includes(status.state)) {
          cancellationSent.add(operation.operationKey);
          await client.cancel(status.operationId, {
            signal: AbortSignal.timeout(2000),
            ...(status.fingerprint ? { fingerprint: status.fingerprint } : {}),
          });
        }
      } catch {
        /* Every sibling is still attempted; response loss is observed below. */
      }
    }
  // Each operation is reconciled on its own. A sibling that finished
  // successfully must not mask another that this request actually contained,
  // and a failure that predates this request must not be reported as a
  // cancellation it did not cause.
  const outcomes: AdminOperationCancellation[] = [];
  const readSignal = () =>
    options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(2_000)])
      : AbortSignal.timeout(2_000);
  for (const operation of pending) {
    if (operation.phase === "refused" || operation.phase === "unissued") {
      outcomes.push("already_terminal");
      continue;
    }
    if (operation.terminal && operation.receiptDelivery) {
      if (!options.context) return "pending";
      try {
        await ensureAdminJobReceiptDelivery(
          options.context,
          projection,
          operation,
          client as ApiOpsClient,
        );
      } catch (error) {
        if (error instanceof JobObservationPending) throw error;
        return "pending";
      }
      const receipt = operation.receiptDelivery.terminalReceipt;
      outcomes.push(
        receipt.state === "succeeded"
          ? "succeeded"
          : receipt.terminationRequestedAt !== undefined
            ? "contained"
            : "already_terminal",
      );
      continue;
    }
    if (options.signal?.aborted) return "pending";
    if (options.jobId && operation.attempt && operation.attempt.apiJobId !== options.jobId)
      return "pending";
    if (!operation.operationId) {
      if (!operation.operation) return "pending";
      try {
        const found = await client.lookup(operation.operation, operation.operationKey, {
          signal: readSignal(),
          ...(operation.attempt
            ? { execution: { requestedDeadlineAt: operation.attempt.requestedDeadlineAt } }
            : {}),
        });
        if (found.kind !== operation.kind || found.operationKey !== operation.operationKey)
          return "pending";
        operation.operationId = found.operationId;
        operation.fingerprint = found.fingerprint;
        operation.deadlineAt = found.deadlineAt;
      } catch {
        return "pending";
      }
    }
    // The agent enters `termination_pending` only from a cancellation request,
    // so observing it here is equivalent evidence to the durable marker.
    let sawTerminationPending = false;
    let status: Awaited<ReturnType<ApiOpsClient["cancel"]>> | undefined;
    const matches = (value: Awaited<ReturnType<ApiOpsClient["cancel"]>>) =>
      value &&
      value.operationId === operation.operationId &&
      value.operationKey === operation.operationKey &&
      value.kind === operation.kind &&
      (operation.fingerprint === undefined || value.fingerprint === operation.fingerprint) &&
      (operation.deadlineAt === undefined || value.deadlineAt === operation.deadlineAt);
    try {
      status = await client.status(operation.kind, operation.operationId, { signal: readSignal() });
      if (!matches(status)) return "pending";
      sawTerminationPending = status.state === "termination_pending";
      if (
        !["succeeded", "failed", "timed_out"].includes(status.state) &&
        !cancellationSent.has(operation.operationKey)
      )
        status = await client.cancel(operation.operationId, {
          signal: readSignal(),
          ...(operation.fingerprint ? { fingerprint: operation.fingerprint } : {}),
        });
    } catch {
      // The cancel request may have reached the agent. Reconcile through its
      // authenticated journal status rather than treating response loss as success.
    }
    for (let attempt = 0; attempt < CANCEL_POLL_ATTEMPTS; attempt += 1) {
      if (options.signal?.aborted) return "pending";
      if (!status || !["succeeded", "failed", "timed_out"].includes(status.state)) {
        try {
          status = await client.status(operation.kind, operation.operationId, {
            signal: readSignal(),
          });
        } catch {
          status = undefined;
        }
      }
      if (status) {
        if (
          status.operationId !== operation.operationId ||
          status.operationKey !== operation.operationKey ||
          (operation.fingerprint !== undefined && status.fingerprint !== operation.fingerprint) ||
          (operation.deadlineAt !== undefined && status.deadlineAt !== operation.deadlineAt) ||
          status.kind !== operation.kind
        ) {
          throw new Error("Invalid operations cancellation status");
        }
        await options.onEvidence?.({
          ...status.failureResult,
          ...(status.diagnostics ? { diagnostics: status.diagnostics } : {}),
        });
        if (status.errorClass === "recovery_required") return "pending";
        if (status.state === "termination_pending") sawTerminationPending = true;
        if (status.state === "succeeded") break;
        if (status.state === "failed" || status.state === "timed_out") break;
      }
      if (attempt + 1 < CANCEL_POLL_ATTEMPTS) await sleep(pollIntervalMs);
    }
    if (!status || !["succeeded", "failed", "timed_out"].includes(status.state)) return "pending";
    operation.terminal = true;
    operation.phase = "terminal";
    operation.fingerprint = status.fingerprint;
    operation.deadlineAt = status.deadlineAt;
    if (status.state === "succeeded") operation.result = status.result;
    else {
      operation.errorClass = status.errorClass;
      operation.failureResult = status.failureResult;
    }
    if (projection.version === 3 && opsKindRequiresControlAuthority(operation.kind)) {
      if (!options.context) return "pending";
      try {
        await ensureAdminJobReceiptDelivery(
          options.context,
          projection,
          operation,
          client as ApiOpsClient,
          status,
        );
      } catch (error) {
        if (error instanceof JobObservationPending) throw error;
        return "pending";
      }
    }
    outcomes.push(
      status.state === "succeeded"
        ? "succeeded"
        : status.terminationRequestedAt !== undefined || sawTerminationPending
          ? "contained"
          : "already_terminal",
    );
  }
  const latestBackend = await cancelAdminDataChildren(
    options.context?.checkpointResult ?? result,
    pending,
    options,
  );
  if (backend === "pending" || latestBackend === "pending") return "pending";
  if (backend === "contained" || latestBackend === "contained") outcomes.push("contained");
  else if (backend === "already_terminal" || latestBackend === "already_terminal")
    outcomes.push("already_terminal");
  if (hasUnsettledHardlinks(result)) return "pending";
  const standaloneResult = options.context?.checkpointResult ?? result;
  if (
    standaloneResult &&
    typeof standaloneResult === "object" &&
    "_standalone" in standaloneResult
  ) {
    const { hasVerifiedStandaloneRestoration } = await import(
      "./standalone-integrations/settlement-checkpoint"
    );
    if (await hasVerifiedStandaloneRestoration(standaloneResult, options.jobId)) return "canceled";
  }
  if (outcomes.includes("contained")) return "canceled";
  return outcomes.every((outcome) => outcome === "succeeded") ? "completed" : "already_terminal";
}
