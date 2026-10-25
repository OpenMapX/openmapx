import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  bindControlChildPhase,
  cliDataReservation,
  closeControlInstallation,
  consumeControlChildDispatch,
  controlChildOperationKey,
  controlRegisteredServiceIds,
  controlRolePublicKey,
  fixedDataBodyFingerprint,
  issueControlChildPhase,
  openControlInstallation,
  readCliDataAttempt,
  retainAdmittedControlExecution,
  retainCliDataAttempt,
  retainControlEffectReceipt,
  verifyCliDataTerminal,
} from "@openmapx/core/build-artifacts";
import {
  type DataChildAttempt,
  type DataExecutionInput,
  type DataExecutionStatus,
  dataExecutionStatusSchema,
  normalizeDataExecutionInput,
  ordinaryDataExecutionInputSchema,
} from "@openmapx/core/data-manager-contracts";
import {
  DataExecutionObservationPending,
  type DataManagerTransport,
  lookupDataExecution,
  observeDataExecution,
  startDataExecution,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import {
  createControlRootOperationKey,
  normalizeExecutionAdmission,
  type OpsOperation,
  opsExecutionBudget,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { cliControlContext, withHostDataControlContext } from "./control-context";
import { repoPaths } from "./paths";
export async function executeDurableDataStep(
  input: DataExecutionInput,
  options: {
    operationKey: string;
    transport: DataManagerTransport;
    signal?: AbortSignal;
    requestedDeadlineAt: number;
    parentAssertion?: string;
    observerDeadlineAt: number;
    checkpointAttempt: (attempt: DataChildAttempt) => Promise<void>;
    checkpoint: (status: DataExecutionStatus) => Promise<void>;
  },
): Promise<DataExecutionStatus> {
  const context = cliControlContext();
  if (!context) throw Error("Retained data command owner required");
  const normalized = ordinaryDataExecutionInputSchema.parse(normalizeDataExecutionInput(input)),
    slot = cliDataReservation(context.authority),
    bound = await bindControlChildPhase(context.authority, slot);
  if (
    options.operationKey !== slot.execution.operationKey ||
    options.requestedDeadlineAt !== bound.execution.deadlineAt ||
    fixedDataBodyFingerprint(normalized) !== slot.operationFingerprint
  )
    throw Error("Data step differs from retained command plan");
  const identity = {
    id: bound.execution.executionId,
    operationKey: bound.execution.operationKey,
    fingerprint: bound.execution.fingerprint,
  };
  const match = (value: unknown) => {
    const status = dataExecutionStatusSchema.parse(value);
    if (
      status.id !== identity.id ||
      status.operationKey !== identity.operationKey ||
      status.fingerprint !== identity.fingerprint ||
      status.deadlineAt !== bound.execution.deadlineAt ||
      status.kind !== normalized.kind
    )
      throw new DataExecutionObservationPending(identity, "transport");
    return status;
  };
  let attempt = readCliDataAttempt(context.authority, slot.execution.operationKey),
    status: DataExecutionStatus | undefined;
  if (!attempt) {
    attempt = {
      phase: "data-step",
      operationKey: slot.execution.operationKey,
      input: normalized,
      operationFingerprint: slot.operationFingerprint,
      requestedDeadlineAt: options.requestedDeadlineAt,
      parentExecution: context.authority.execution,
      state: "prepared",
    };
    await options.checkpointAttempt(attempt);
    if (!options.parentAssertion) throw Error("Original signed data parent assertion required");
    attempt = { ...attempt, state: "attempted" };
    await options.checkpointAttempt(attempt);
    try {
      status = match(
        unwrapDataManagerResponse(
          await startDataExecution(
            {
              operationKey: options.operationKey,
              input: normalized,
              requestedDeadlineAt: options.requestedDeadlineAt,
            },
            {
              transport: options.transport,
              signal: options.signal,
              headers: { "x-openmapx-parent-execution": options.parentAssertion },
            },
          ),
        ),
      );
    } catch {
      /* An ambiguous POST is lookup-only, including 404/410. */
    }
  }
  if (!status)
    try {
      status = match(
        unwrapDataManagerResponse(
          await lookupDataExecution(options.operationKey, {
            transport: options.transport,
            signal: options.signal,
          }),
        ),
      );
    } catch {
      throw new DataExecutionObservationPending(
        identity,
        options.signal?.aborted ? "interrupted" : "transport",
      );
    }
  attempt = {
    ...attempt,
    state: "observing",
    id: status.id,
    fingerprint: status.fingerprint,
    deadlineAt: status.deadlineAt,
  };
  await options.checkpointAttempt(attempt);
  await options.checkpoint(status);
  let checkpoints: Promise<void> = Promise.resolve();
  let checkpointError: unknown;
  const terminal = await observeDataExecution(identity, {
    transport: options.transport,
    signal: options.signal,
    observerDeadlineAt: options.observerDeadlineAt,
    onProgress: (status) => {
      checkpoints = checkpoints
        .then(() => options.checkpoint(status))
        .catch((error) => {
          checkpointError ??= error;
        });
    },
  });
  await checkpoints;
  if (checkpointError) throw checkpointError;
  // The terminal GET precedes final physical target release by a small window.
  // Wait for the actual DM-signed shared containment witness, never infer it.
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      verifyCliDataTerminal(context.authority, terminal);
      break;
    } catch {
      if (Date.now() >= options.observerDeadlineAt)
        throw new DataExecutionObservationPending(identity, "observer_deadline");
      await delay(100, undefined, { signal: options.signal });
    }
  }
  await options.checkpointAttempt({ ...attempt, state: "terminal" });
  return terminal;
}
function operationFor(input: DataExecutionInput): OpsOperation {
  switch (input.kind) {
    case "download-osm":
      return { kind: "data.downloadOsm", regionId: input.region };
    case "download-fonts":
      return { kind: "data.downloadFonts" };
    case "convert-overpass":
      return { kind: "data.convertOverpass", regionId: input.region };
    case "overture-sync":
      return { kind: "data.overtureSync", regionId: input.region };
    case "overture-conflate":
      return { kind: "data.overtureConflate", regionId: input.region, restart: input.restart };
    case "search-index-build":
      return { kind: "data.searchIndexBuild", regionId: input.region };
    case "notable-places-build":
      return { kind: "data.notablePlacesBuild" };
    default:
      throw Error("No existing single-command edge for this data input");
  }
}
async function runOwned(input: DataExecutionInput, transport: DataManagerTransport) {
  const context = cliControlContext();
  if (!context) throw Error("Data command owner required");
  const slot = cliDataReservation(context.authority),
    bound = await bindControlChildPhase(context.authority, slot);
  const prior = readCliDataAttempt(context.authority, slot.execution.operationKey);
  let assertion: string | undefined;
  if (!prior) {
    const issued = await issueControlChildPhase(context.authority, {
      phase: "data-step",
      ordinal: 0,
      childPublicKey: controlRolePublicKey(context.installation, "data-manager"),
    });
    assertion = issued.assertion;
    consumeControlChildDispatch(issued.dispatchTicket);
  }
  const result = await executeDurableDataStep(input, {
    operationKey: slot.execution.operationKey,
    requestedDeadlineAt: bound.execution.deadlineAt,
    parentAssertion: assertion,
    transport,
    observerDeadlineAt: context.authority.execution.deadlineAt,
    checkpointAttempt: async (attempt) => retainCliDataAttempt(context.authority, attempt),
    checkpoint: async () => {},
  });
  if (result.status !== "ok") throw Error(`Data execution ${result.id} finished ${result.status}`);
  return result;
}
/** Host commands use their own dated, retained coordinator. Managed fixed CLI
 * commands reuse their certified root-fixed slot and acquire no target root. */
export async function runCliDataStep(
  value: DataExecutionInput,
  transport: DataManagerTransport,
): Promise<DataExecutionStatus> {
  const input = normalizeDataExecutionInput(value);
  if (cliControlContext()) return runOwned(input, transport);
  const operation = operationFor(input),
    admittedAt = Date.now(),
    requestedDeadlineAt = admittedAt + opsExecutionBudget(operation.kind).processMs,
    operationKey = createControlRootOperationKey({
      notAfter: requestedDeadlineAt,
      nonce: randomBytes(16),
    }),
    installation = openControlInstallation({
      infraDir: repoPaths().infraDir,
      role: "host-cli",
      serviceIds: ["data-manager"],
    });
  const normalized = normalizeExecutionAdmission({
      kind: operation.kind,
      operationKey,
      operationFingerprint: opsOperationFingerprint(operation),
      admittedAt,
      requestedDeadlineAt,
    }),
    execution = {
      executor: "host-cli" as const,
      principal: "host-cli" as const,
      executionId: randomUUID(),
      operationKey,
      operationFingerprint: opsOperationFingerprint(operation),
      fingerprint: normalized.fingerprint,
      deadlineAt: normalized.deadlineAt,
    };
  try {
    const authority = retainAdmittedControlExecution(installation, {
      execution,
      operation,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt,
      serviceIds: controlRegisteredServiceIds(installation),
      reservations: [
        {
          version: 1,
          phase: "data-step",
          ordinal: 0,
          kind: input.kind,
          recipient: "data-manager",
          serviceIds: ["data-manager"],
          operationFingerprint: fixedDataBodyFingerprint(input),
          execution: {
            executor: "data-manager",
            principal: "host-cli",
            executionId: randomUUID(),
            operationKey: controlChildOperationKey(operationKey, "data-step", 0),
          },
        },
      ],
    });
    const result = await withHostDataControlContext(installation, authority, () =>
      runOwned(input, transport),
    );
    retainControlEffectReceipt(authority, {
      outcome: "committed",
      publication: "committed",
      receipt: { kind: "data-command", status: result },
    });
    return result;
  } finally {
    closeControlInstallation(installation);
  }
}
