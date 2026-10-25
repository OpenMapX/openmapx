import { createHash, randomUUID } from "node:crypto";
import {
  type ControlChildReservation,
  controlChildOperationKey,
} from "@openmapx/core/build-artifacts";
import type { DataExecutionInput } from "@openmapx/core/data-manager-contracts";
import {
  canonicalJson,
  type ExecutionRef,
  executionRefSchema,
  type OpsOperation,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import z from "zod/v4";
export const DATA_EFFECT_KINDS = [
  "motis.primary.stop",
  "motis.staging.stop",
  "motis.staging.restart",
  "motis.primary.promote",
  "motis.primary.restart",
  "feedProxy.validateAndReload",
  "transitousLock.approve",
] as const;
export type DataEffectKind = (typeof DATA_EFFECT_KINDS)[number];
export const dataOpsChildPhaseSchema = z.enum([
  "stop-primary",
  "stop-staging",
  "restart-staging",
  "promote-primary",
  "recover-primary",
  "proxy-stage",
  "proxy-commit",
  "proxy-restore",
  "paired-pin-commit",
]);
export type DataOpsChildPhase = z.infer<typeof dataOpsChildPhaseSchema>;
export const DATA_PHASE_KINDS: Record<DataOpsChildPhase, DataEffectKind> = {
  "stop-primary": "motis.primary.stop",
  "stop-staging": "motis.staging.stop",
  "restart-staging": "motis.staging.restart",
  "promote-primary": "motis.primary.promote",
  "recover-primary": "motis.primary.restart",
  "proxy-stage": "feedProxy.validateAndReload",
  "proxy-commit": "feedProxy.validateAndReload",
  "proxy-restore": "feedProxy.validateAndReload",
  "paired-pin-commit": "transitousLock.approve",
};
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  key = z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  receiverId = z.string().regex(/^job1_[A-Za-z0-9_-]{16,64}$/);

import { opsOperationSchema } from "@openmapx/core/ops";

const operationSchema = opsOperationSchema.transform((operation) => {
  switch (operation.kind) {
    case "motis.primary.stop":
    case "motis.staging.stop":
    case "motis.staging.restart":
    case "motis.primary.promote":
    case "motis.primary.restart":
    case "feedProxy.validateAndReload":
    case "transitousLock.approve":
      return operation;
    default:
      throw Error("Unsupported data-manager host effect");
  }
});
const common = {
  proxyRecovery: z.strictObject({ version: z.literal(1), backupDigest: digest }).optional(),
  parentExecution: executionRefSchema,
  phase: dataOpsChildPhaseSchema,
  ordinal: z.number().int().min(0).max(31),
  operation: operationSchema,
  operationFingerprint: digest,
  operationKey: key,
  proposedId: receiverId,
  serviceIds: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .min(1)
    .max(256)
    .refine((ids) => ids.every((id, i) => i === 0 || (ids[i - 1] ?? id) < id)),
  cancellationRequestedAt: z.iso.datetime({ offset: true }).nullable(),
};
const bound = {
  ...common,
  execution: executionRefSchema,
  requestedDeadlineAt: z.number().int().nonnegative().safe(),
  bindingDigest: digest,
  candidateDigest: digest.nullable(),
};
const attempted = {
  ...bound,
  delegationId: z.uuid(),
  grantDigest: digest,
  leaseId: z.uuid(),
  dispatchState: z.enum(["pending", "claimed"]),
};
export const dataOpsChildReservedSchema = z.strictObject({
  ...common,
  state: z.literal("reserved"),
  publication: z.literal("not_started"),
});
export const dataOpsChildAttemptSchema = z
  .discriminatedUnion("state", [
    dataOpsChildReservedSchema,
    z.strictObject({ ...bound, state: z.literal("bound"), publication: z.literal("not_started") }),
    z.strictObject({
      ...attempted,
      state: z.literal("attempted"),
      publication: z.enum(["not_started", "unknown"]),
    }),
    z.strictObject({
      ...attempted,
      state: z.literal("observing"),
      acceptedId: receiverId,
      publication: z.enum(["not_started", "committed", "unknown"]),
    }),
    z.strictObject({
      ...attempted,
      state: z.literal("terminal"),
      acceptedId: receiverId,
      publication: z.enum(["not_started", "committed"]),
      settlement: z.strictObject({
        outcome: z.enum(["contained", "committed", "failed_without_effect"]),
        terminalReceiptDigest: digest,
      }),
    }),
    z.strictObject({
      ...attempted,
      state: z.literal("unknown"),
      acceptedId: receiverId.optional(),
      publication: z.literal("unknown"),
    }),
  ])
  .superRefine((child, ctx) => {
    if (child.proxyRecovery && child.phase !== "proxy-restore")
      ctx.addIssue({
        code: "custom",
        message: "Only the original restore may retain backup provenance",
      });
    if (
      DATA_PHASE_KINDS[child.phase] !== child.operation.kind ||
      opsOperationFingerprint(child.operation) !== child.operationFingerprint ||
      child.operationKey !==
        controlChildOperationKey(child.parentExecution.operationKey, child.phase, child.ordinal)
    )
      ctx.addIssue({ code: "custom", message: "Child body or phase identity mismatch" });
    if (
      child.state !== "reserved" &&
      (child.execution.operationKey !== child.operationKey ||
        child.execution.executionId !== child.proposedId ||
        child.execution.operationFingerprint !== child.operationFingerprint ||
        child.execution.executor !== "ops-agent" ||
        child.execution.principal !== "data-manager" ||
        child.execution.deadlineAt !== child.requestedDeadlineAt)
    )
      ctx.addIssue({ code: "custom", message: "Bound child identity mismatch" });
    if (
      "acceptedId" in child &&
      child.acceptedId !== undefined &&
      child.acceptedId !== child.proposedId
    )
      ctx.addIssue({ code: "custom", message: "Foreign accepted child" });
    if (new TextEncoder().encode(JSON.stringify(child)).length > 8192)
      ctx.addIssue({ code: "custom", message: "Child receipt capacity exceeded" });
  });
export type DataOpsChildAttempt = z.infer<typeof dataOpsChildAttemptSchema>;
export type DataOpsChildReserved = z.infer<typeof dataOpsChildReservedSchema>;
export function transitChildCandidateId(
  execution: Pick<ExecutionRef, "operationKey">,
  phase: DataOpsChildPhase,
  ordinal: number,
): string {
  return `ctrl-${createHash("sha256").update(`openmapx-transit-candidate-v1\0${execution.operationKey}\0${phase}\0${ordinal}`).digest("hex").slice(0, 32)}`;
}
export function dataChildControlReservation(
  child: DataOpsChildReserved | DataOpsChildAttempt,
): ControlChildReservation {
  return {
    version: 1,
    phase: child.phase,
    ordinal: child.ordinal,
    kind: child.operation.kind,
    recipient: "ops-agent",
    serviceIds: child.serviceIds,
    operationFingerprint: child.operationFingerprint,
    execution: {
      executor: "ops-agent",
      principal: "data-manager",
      executionId: child.proposedId,
      operationKey: child.operationKey,
    },
  };
}
/** Full typed bodies and IDs are persisted at root admission, before build writes. */
export function reserveTransitChildOperations(
  execution: ExecutionRef,
  input: DataExecutionInput,
): DataOpsChildReserved[] {
  const entries: Array<{ phase: DataOpsChildPhase; operation: OpsOperation; targets: string[] }> =
    [];
  if (input.kind === "transit-sync") {
    entries.push(
      { phase: "stop-primary", operation: { kind: "motis.primary.stop" }, targets: ["motis"] },
      {
        phase: "stop-staging",
        operation: { kind: "motis.staging.stop" },
        targets: ["motis-staging"],
      },
      {
        phase: "restart-staging",
        operation: { kind: "motis.staging.restart" },
        targets: ["motis-staging"],
      },
      {
        phase: "promote-primary",
        operation: { kind: "motis.primary.promote", preparedRunId: execution.executionId },
        targets: ["motis"],
      },
      {
        phase: "recover-primary",
        operation: { kind: "motis.primary.restart" },
        targets: ["motis"],
      },
    );
    for (const phase of ["proxy-stage", "proxy-commit", "proxy-restore"] as const) {
      const ordinal = entries.length;
      entries.push({
        phase,
        operation: {
          kind: "feedProxy.validateAndReload",
          candidateId: transitChildCandidateId(execution, phase, ordinal),
        },
        targets: ["motis-feed-proxy"],
      });
    }
  } else if (input.kind === "transit-maintenance") {
    if (input.action === "restart-primary")
      entries.push({
        phase: "recover-primary",
        operation: { kind: "motis.primary.restart" },
        targets: ["motis"],
      });
    else {
      const expected = transitChildCandidateId(execution, "proxy-commit", 0);
      if (input.candidateId !== expected)
        throw Error("Feed proxy candidate must be reserved by this root");
      entries.push({
        phase: "proxy-commit",
        operation: { kind: "feedProxy.validateAndReload", candidateId: expected },
        targets: ["motis-feed-proxy"],
      });
    }
  }
  return entries.map(({ phase, operation, targets }, ordinal) =>
    dataOpsChildReservedSchema.parse({
      parentExecution: execution,
      phase,
      ordinal,
      operation,
      operationFingerprint: opsOperationFingerprint(operation),
      operationKey: controlChildOperationKey(execution.operationKey, phase, ordinal),
      proposedId: `job1_${randomUUID().replaceAll("-", "")}`,
      serviceIds: targets,
      cancellationRequestedAt: null,
      state: "reserved",
      publication: "not_started",
    }),
  );
}
export function sameDataChildBody(
  a: DataOpsChildReserved | DataOpsChildAttempt,
  b: DataOpsChildReserved | DataOpsChildAttempt,
): boolean {
  const immutable = (c: DataOpsChildReserved | DataOpsChildAttempt) => ({
    parentExecution: c.parentExecution,
    phase: c.phase,
    ordinal: c.ordinal,
    operation: c.operation,
    operationFingerprint: c.operationFingerprint,
    operationKey: c.operationKey,
    proposedId: c.proposedId,
    serviceIds: c.serviceIds,
  });
  return canonicalJson(immutable(a)) === canonicalJson(immutable(b));
}

import { setTimeout as delay } from "node:timers/promises";
import {
  assertOwnedDataTransitCandidate,
  bindControlChildPhase,
  consumeControlChildDispatch,
  controlRolePublicKey,
  inspectArtifactTargetLeaseChildSettlement,
  issueControlChildPhase,
  lookupControlChildPhaseAttempt,
  lookupControlChildPhaseBinding,
  verifyFeedProxyCanonicalTerminal,
} from "@openmapx/core/build-artifacts";
import { type OpsJobStatus, type OpsResultFor, parseOpsResult } from "@openmapx/core/ops";
import { opsClient } from "../../ops-client.js";
import type { DataExecutionContext } from "./runtime.js";
import type { FreshDataChildReservation } from "./store.js";
export class DataOpsObservationPending extends Error {
  constructor(readonly operationKey: string) {
    super("Owned data child requires observation and settlement");
  }
}
export class DataOpsChildFailed extends Error {}
export async function lookupOwnedDataOpsChildren(
  context: DataExecutionContext,
): Promise<readonly DataOpsChildAttempt[]> {
  return (await context.record()).children;
}
function sameStatus(child: DataOpsChildAttempt, status: OpsJobStatus) {
  if (
    child.state === "reserved" ||
    status.version !== 2 ||
    status.operationId !== child.proposedId ||
    status.operationKey !== child.operationKey ||
    status.kind !== child.operation.kind ||
    status.fingerprint !== child.execution.fingerprint ||
    status.deadlineAt !== child.execution.deadlineAt
  )
    throw new DataOpsObservationPending(child.operationKey);
}
async function checkpointCurrent<T extends DataOpsChildAttempt>(
  context: DataExecutionContext,
  child: T,
) {
  await context.checkpointChild(child);
  return child;
}
async function observeChild(
  context: DataExecutionContext,
  attempt: DataOpsChildAttempt,
  signal: AbortSignal,
  cancel = false,
): Promise<OpsJobStatus> {
  if (attempt.state === "reserved" || attempt.state === "bound")
    throw new DataOpsObservationPending(attempt.operationKey);
  let child = attempt;
  if (cancel && child.state !== "terminal") {
    child = await checkpointCurrent(context, {
      ...child,
      cancellationRequestedAt: child.cancellationRequestedAt ?? new Date().toISOString(),
    });
    try {
      await opsClient().cancel(child.proposedId, {
        fingerprint: child.execution.fingerprint,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
    } catch {
      /* exact durable intent permits cancel retry, never POST replay */
    }
  }
  while (true) {
    signal.throwIfAborted();
    let status: OpsJobStatus;
    try {
      status = await opsClient().lookup(child.operation, child.operationKey, {
        fingerprint: child.execution.fingerprint,
        execution: { requestedDeadlineAt: child.requestedDeadlineAt },
        signal,
      });
    } catch {
      await context.checkpoint({ publication: "unknown" });
      await delay(100, undefined, { signal });
      continue;
    }
    sameStatus(child, status);
    const saved: DataOpsChildAttempt = {
      ...child,
      state: "observing",
      acceptedId: status.operationId,
      publication: child.publication,
    };
    if (child.state !== "terminal") child = await checkpointCurrent(context, saved);
    if (["succeeded", "failed", "timed_out"].includes(status.state)) {
      let evidence: ReturnType<typeof inspectArtifactTargetLeaseChildSettlement>;
      try {
        evidence = inspectArtifactTargetLeaseChildSettlement(
          context.targetAuthority,
          child.execution,
        );
      } catch {
        await delay(100, undefined, { signal });
        continue;
      }
      if (evidence && evidence.outcome !== "unknown" && evidence.publication !== "unknown") {
        if (child.operation.kind === "feedProxy.validateAndReload") {
          try {
            verifyFeedProxyCanonicalTerminal(context.authority, child.execution);
          } catch {
            await delay(100, undefined, { signal });
            continue;
          }
        }
        child = await checkpointCurrent(context, {
          ...child,
          state: "terminal",
          acceptedId: status.operationId,
          publication: evidence.publication,
          settlement: {
            outcome: evidence.outcome,
            terminalReceiptDigest: evidence.terminalReceiptDigest,
          },
        });
        if (evidence.publication === "committed")
          await context.checkpoint({ publication: "committed" });
        return status;
      }
    }
    await delay(100, undefined, { signal });
  }
}
/** Body-first confirmed CAS -> signed one-time binding -> grant/ref -> confirmed
 * claimed CAS -> consume fresh nominal ticket -> exactly one mutation POST. */
type OwnedDataOpsOptions = {
  context: DataExecutionContext;
  phase: DataOpsChildPhase;
  ordinal: number;
  serviceIds: readonly string[];
  reservedContinuation?: FreshDataChildReservation;
};
/** Reserve the original restore before touching either live file. Only the
 * confirmed live CAS continuation may later dispatch this exact same phase. */
export async function reserveOwnedProxyRecovery(
  context: DataExecutionContext,
  backupDigest: string,
): Promise<FreshDataChildReservation> {
  context.assertForward();
  const record = await context.record(),
    slot = record.reservations.find((child) => child.phase === "proxy-restore");
  if (!slot) throw Error("Original proxy restore reservation missing");
  const reserved = await context.write(async (current) => {
    const saved = await context.store.reserveChild(current.status.id, current.version, {
      ...slot,
      proxyRecovery: { version: 1, backupDigest },
    });
    if (!saved?.continuation) throw new DataOpsObservationPending(slot.operationKey);
    return { record: saved.record, value: saved.continuation };
  });
  if (!context.store.controlJournal) throw Error("Original proxy recovery journal missing");
  await context.store.controlJournal.retainProxyRecoveryIntent(context.authority, backupDigest);
  context.assertForward();
  return reserved;
}
export async function runOwnedDataOpsOperation<K extends DataEffectKind>(
  value: Extract<OpsOperation, { kind: K }>,
  options: OwnedDataOpsOptions,
): Promise<OpsResultFor<K>> {
  const operation = operationSchema.parse(value);
  const { context } = options,
    record = await context.record(),
    slot = record.reservations.find(
      (child) => child.phase === options.phase && child.ordinal === options.ordinal,
    );
  if (
    !slot ||
    slot.operationFingerprint !== opsOperationFingerprint(operation) ||
    canonicalJson(slot.operation) !== canonicalJson(operation) ||
    canonicalJson(slot.serviceIds) !== canonicalJson(options.serviceIds)
  )
    throw Error("Operation differs from original data phase reservation");
  if (operation.kind === "transitousLock.approve")
    throw Error("Paired pin approval requires the validation-bound activation runtime");
  let child: DataOpsChildAttempt | undefined = record.children.find(
    (value) => value.operationKey === slot.operationKey,
  );
  if (!child || (child.state === "reserved" && options.reservedContinuation)) {
    context.assertForward();
    const candidateDigest = assertOwnedDataTransitCandidate(context.authority, slot);
    if (!child && slot.phase === "proxy-restore")
      throw Error("Restore must reserve before filesystem writes");
    const reserved = options.reservedContinuation
      ? { record, continuation: options.reservedContinuation }
      : await context.write(async (current) => {
          const saved = await context.store.reserveChild(current.status.id, current.version, slot);
          if (!saved) throw new DataOpsObservationPending(slot.operationKey);
          return { record: saved.record, value: saved };
        });
    child = reserved.record.children.find((value) => value.operationKey === slot.operationKey);
    if (reserved.continuation) {
      const reservedBody = child?.state === "reserved" ? child : slot;
      const exact = await bindControlChildPhase(context.authority, slot),
        binding = lookupControlChildPhaseBinding(context.authority, slot);
      if (!binding) throw new DataOpsObservationPending(slot.operationKey);
      const bound: DataOpsChildAttempt = {
        ...reservedBody,
        state: "bound",
        execution: exact.execution,
        requestedDeadlineAt: binding.requestedDeadlineAt,
        bindingDigest: binding.bindingDigest,
        candidateDigest,
      };
      await context.checkpointChild(bound);
      child = bound;
      context.assertForward();
      if (assertOwnedDataTransitCandidate(context.authority, slot) !== candidateDigest)
        throw Error("Owned candidate changed before grant");
      const issued = await issueControlChildPhase(context.authority, {
        phase: slot.phase,
        ordinal: slot.ordinal,
        lease: context.targetAuthority,
        childPublicKey: controlRolePublicKey(context.installation, "ops-agent"),
      });
      const reference = lookupControlChildPhaseAttempt(context.authority, slot);
      if (!reference?.leaseId) throw new DataOpsObservationPending(slot.operationKey);
      const attempted: DataOpsChildAttempt = {
        ...bound,
        state: "attempted",
        delegationId: reference.delegationId,
        grantDigest: reference.grantDigest,
        leaseId: reference.leaseId,
        dispatchState: "claimed",
        publication: "unknown",
      };
      if (attempted.state !== "attempted") throw Error("Invalid owned dispatch state");
      await context.write(async (current) => {
        const saved = await context.store.claimChildDispatch(
          current.status.id,
          current.version,
          attempted,
          reserved.continuation!,
        );
        if (!saved) throw new DataOpsObservationPending(slot.operationKey);
        return { record: saved, value: undefined };
      });
      child = attempted;
      await context.checkpoint({ publication: "unknown" });
      consumeControlChildDispatch(issued.dispatchTicket);
      try {
        const admitted = await opsClient().execute(operation, {
          operationKey: child.operationKey,
          execution: { requestedDeadlineAt: child.execution.deadlineAt },
          controlAssertion: issued.assertion,
          signal: context.signal,
        });
        if (admitted.execution !== "async" || admitted.operationId !== child.proposedId)
          throw new DataOpsObservationPending(child.operationKey);
        child = await checkpointCurrent(context, {
          ...child,
          state: "observing",
          acceptedId: admitted.operationId,
        });
      } catch {
        /* first POST is conservatively attempted; only exact lookup follows */
      }
    }
  }
  if (!child) throw new DataOpsObservationPending(slot.operationKey);
  try {
    let status: OpsJobStatus;
    try {
      status = await observeChild(context, child, context.signal);
    } catch (error) {
      if (!context.signal.aborted) throw error;
      // A canceled progress/worker signal cannot own descendant settlement.
      // Repeat bounded reads/cancel intent on the original identity; these
      // live read budgets grant no new forward work or execution time.
      for (;;) {
        const current = (await context.record()).children.find(
          (entry) => entry.operationKey === slot.operationKey,
        );
        if (!current) throw error;
        try {
          status = await observeChild(context, current, AbortSignal.timeout(30000), true);
          break;
        } catch (pending) {
          if (pending instanceof DataOpsChildFailed) throw pending;
          await delay(250);
        }
      }
    }
    if (status.state !== "succeeded")
      throw new DataOpsChildFailed("Owned host child failed with contained effect evidence");
    // Runtime parsing validates the exact admitted kind; this bridges the
    // generic Extract result type and constructs no authority.
    return parseOpsResult(operation.kind, status.result) as OpsResultFor<K>;
  } catch (error) {
    if (error instanceof DataOpsChildFailed) throw error;
    throw new DataOpsObservationPending(slot.operationKey);
  }
}
export async function cancelAndSettleOwnedDataOpsChildren(
  context: DataExecutionContext,
): Promise<"settled" | "pending"> {
  const record = await context.record(),
    signal = AbortSignal.timeout(30000);
  let pending = false;
  for (const slot of record.reservations) {
    let child = record.children.find((value) => value.operationKey === slot.operationKey);
    let reference: ReturnType<typeof lookupControlChildPhaseAttempt>;
    try {
      reference = lookupControlChildPhaseAttempt(context.authority, slot);
    } catch {
      pending = true;
      continue;
    }
    if (!child && !reference) continue;
    if (child?.state === "terminal") continue;
    try {
      if (reference && (!child || child.state === "reserved" || child.state === "bound")) {
        // Recover only the original binding/grant. No issuance or dispatch ticket.
        const binding = lookupControlChildPhaseBinding(context.authority, slot);
        if (!binding || !reference.leaseId) throw new DataOpsObservationPending(slot.operationKey);
        if (!child) throw new DataOpsObservationPending(slot.operationKey);
        const bound = {
          ...slot,
          state: "bound" as const,
          execution: binding.child.execution,
          requestedDeadlineAt: binding.requestedDeadlineAt,
          bindingDigest: binding.bindingDigest,
          candidateDigest:
            child.state === "bound"
              ? child.candidateDigest
              : assertOwnedDataTransitCandidate(context.authority, slot),
        };
        if (child.state === "reserved") await context.checkpointChild(bound);
        child = {
          ...bound,
          state: "attempted",
          delegationId: reference.delegationId,
          grantDigest: reference.grantDigest,
          leaseId: reference.leaseId,
          dispatchState: "pending",
          publication: "unknown",
        };
        await context.checkpointChild(child);
      }
      if (!child || child.state === "reserved" || child.state === "bound")
        throw new DataOpsObservationPending(slot.operationKey);
      await observeChild(
        context,
        child,
        signal,
        record.status.cancellationRequestedAt !== null || context.signal.aborted,
      );
    } catch {
      pending = true;
    }
  }
  return pending ? "pending" : "settled";
}
