import {
  canonicalJson,
  configurationMaintenanceReceiptSchema,
  parseControlRootOperationKey,
} from "@openmapx/core/ops";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { readProjection } from "./admin-job-projection";
import {
  ADMIN_JOB_LOG_LIMITS,
  type JobExecution,
  JobOwnershipLost,
  JobStepAllocationConflict,
  JobStepCapacityExceeded,
  jobOwnership,
} from "./admin-job-state";
import { assertConfigurationMaintenanceProjectedStep } from "./configuration-maintenance-step-records";

import { assertStandaloneSettlementCheckpoint } from "./standalone-integrations/settlement-checkpoint";

const equal = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
/** Called only for v3. The database row lock owns uniqueness, capacity and merges. */
export async function checkpointOwnedAdminJob(
  id: string,
  execution: JobExecution | undefined,
  candidate: Record<string, unknown>,
  progress?: number,
  admissionKey?: string,
  stepAddress?: string,
  baseline: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(adminJob)
      .where(jobOwnership(id, execution, ["running", "cancel_pending"]))
      .for("update");
    if (!row) throw new JobOwnershipLost();
    const current = (row.result ?? {}) as Record<string, unknown>,
      old = readProjection(current),
      next = readProjection(candidate);
    if (next.version !== 3) throw Error("Invalid managed checkpoint version");
    let mergedProjection = old;
    let maintenanceDecisionAttempt: Record<string, unknown> | undefined;
    let maintenanceSettleAttempt: Record<string, unknown> | undefined;
    if (admissionKey || stepAddress) {
      if (!admissionKey || !stepAddress || !execution)
        throw Error("Incomplete stable step reservation");
      const mapping = next.steps[stepAddress],
        operation = next.operations[admissionKey];
      if (
        !mapping ||
        mapping.operationKey !== admissionKey ||
        !operation?.attempt ||
        operation.attempt.apiJobId !== id ||
        operation.attempt.apiOwnerVersion !== execution.version ||
        !["admitting", "prepared"].includes(operation.phase) ||
        operation.terminal
      )
        throw Error("Invalid stable step reservation");
      if (
        operation.phase === "prepared" &&
        (row.type !== "service.bulk" ||
          (row.payload as { action?: unknown })?.action !== "update" ||
          operation.operation?.kind !== "service.pull" ||
          operation.operation.serviceId !== "data-manager" ||
          !operation.operation.candidateId)
      )
        throw Error("Only the fixed coordinator pull can be preallocated");
      if (old.steps[stepAddress] || old.operations[stepAddress] || old.operations[admissionKey])
        return { conflict: true as const, result: current };
      if (Object.keys(old.steps).length >= 64 || Object.keys(old.operations).length >= 64)
        return { capacity: true as const, result: current };
      const standaloneSettlement =
        row.type === "standalone.install" && operation.operation?.kind === "integration.settle";
      if (standaloneSettlement)
        await assertStandaloneSettlementCheckpoint(row, operation.operation!, tx);
      if (row.status !== "running" && !standaloneSettlement) throw new JobOwnershipLost();
      if (current._cancelRequestedAt !== undefined && !standaloneSettlement) {
        // Cancellation never authorizes a forward phase. Only the original
        // no-effect Abandon/Settle controls may be checkpointed against the
        // actual already-delivered preparation in THIS owned job row.
        const body = operation.operation;
        if (
          !body ||
          (body.kind !== "configurationMaintenance.settle" &&
            !(body.kind === "configurationMaintenance.decide" && body.decision === "abandon")) ||
          typeof current._cancelRequestedAt !== "string" ||
          !Number.isFinite(Date.parse(current._cancelRequestedAt))
        )
          throw new JobOwnershipLost();
        const original = old.operations[body.prepareOperationKey],
          delivery = original?.receiptDelivery,
          retained = current._configurationCandidate as Record<string, unknown> | undefined,
          maintenance = current._configurationMaintenance as Record<string, unknown> | undefined;
        if (
          original?.kind !== "configurationMaintenance.prepare" ||
          delivery?.state !== "confirmed" ||
          delivery.terminalReceipt.state !== "succeeded"
        )
          throw new JobOwnershipLost();
        const prepared = configurationMaintenanceReceiptSchema.parse(
          delivery.terminalReceipt.result,
        );
        if (
          prepared.apiJobId !== id ||
          prepared.state !== "prepared" ||
          !prepared.dmFence ||
          prepared.binding.candidateId !== body.candidateId ||
          prepared.binding.maintenanceId !== body.maintenanceId ||
          prepared.prepare.operationKey !== body.prepareOperationKey ||
          prepared.prepare.operationFingerprint !== body.prepareFingerprint ||
          prepared.planDigest !== body.planDigest ||
          retained?.candidateId !== body.candidateId ||
          retained.maintenanceId !== body.maintenanceId ||
          retained.prepareOperationKey !== body.prepareOperationKey ||
          maintenance?.candidateId !== body.candidateId ||
          maintenance.maintenanceId !== body.maintenanceId ||
          maintenance.prepareOperationKey !== body.prepareOperationKey ||
          maintenance.prepareOperationFingerprint !== body.prepareFingerprint
        )
          throw new JobOwnershipLost();
        // The exact retained decision/settle body/address/attempt is checked
        // below as usual. The actual agent independently verifies its owner,
        // unused/final eligibility and original-root control; no new grant.
      }
      if (current._parentExecution && !equal(current._parentExecution, candidate._parentExecution))
        return { conflict: true as const, result: current };
      const parent = candidate._parentExecution as
        | { operationKey?: string; fingerprint?: string; deadlineAt?: number }
        | undefined;
      if (
        !parent ||
        parent.operationKey !== operation.attempt.parentOperationKey ||
        parent.fingerprint !== operation.attempt.parentFingerprint ||
        parent.deadlineAt !== operation.attempt.parentDeadlineAt
      )
        throw Error("Incomplete atomic parent reservation");
      if (operation.operation?.kind === "configurationMaintenance.decide") {
        const decision = current._configurationMaintenanceDecision as
            | Record<string, unknown>
            | undefined,
          delivery = decision?.delivery as
            | {
                stepAddress?: unknown;
                root?: { operationKey?: unknown; requestedDeadlineAt?: unknown; parent?: unknown };
              }
            | undefined;
        if (
          !decision ||
          decision.attempt !== "not_attempted" ||
          !equal(decision.operation, operation.operation) ||
          delivery?.stepAddress !== stepAddress ||
          delivery.root?.operationKey !== admissionKey ||
          delivery.root.requestedDeadlineAt !== operation.attempt.requestedDeadlineAt ||
          !equal(delivery.root.parent, parent)
        )
          throw Error("Actual retained maintenance decision admission required");
        maintenanceDecisionAttempt = { ...decision, attempt: "attempted" };
      }
      if (operation.operation?.kind === "configurationMaintenance.settle") {
        const settlement = current._configurationMaintenanceSettle as
            | Record<string, unknown>
            | undefined,
          delivery = settlement?.delivery as
            | {
                stepAddress?: unknown;
                root?: { operationKey?: unknown; requestedDeadlineAt?: unknown; parent?: unknown };
              }
            | undefined;
        if (
          !settlement ||
          settlement.attempt !== "not_attempted" ||
          !equal(settlement.operation, operation.operation) ||
          delivery?.stepAddress !== stepAddress ||
          delivery.root?.operationKey !== admissionKey ||
          delivery.root.requestedDeadlineAt !== operation.attempt.requestedDeadlineAt ||
          !equal(delivery.root.parent, parent)
        )
          throw Error("Actual retained maintenance settlement admission required");
        maintenanceSettleAttempt = { ...settlement, attempt: "attempted" };
      }
      try {
        if (
          parseControlRootOperationKey(admissionKey).notAfter !==
          operation.attempt.requestedDeadlineAt
        )
          throw Error("Original root changed");
      } catch {
        assertConfigurationMaintenanceProjectedStep(
          current,
          admissionKey,
          operation.operation,
          operation.attempt,
        );
      }
      mergedProjection = {
        ...old,
        version: 3,
        steps: { ...old.steps, [stepAddress]: mapping },
        operations: { ...old.operations, [admissionKey]: operation },
      };
    } else {
      const operations = { ...old.operations };
      let eventDelta = 0,
        byteDelta = 0;
      const mapped = new Set(Object.values(next.steps).map((s) => s.operationKey));
      for (const [key, entry] of Object.entries(next.operations)) {
        const previous = old.operations[key];
        if (!previous) throw Error("New operation requires stable address reservation");
        // A stale checkpoint cannot resurrect an unattempted slot after the
        // fixed delivery/nonissuance CAS has won. Keep that actual winner.
        if (previous.phase !== "prepared" && entry.phase === "prepared") {
          operations[key] = previous;
          continue;
        }
        if (entry.phase === "unissued" && previous.phase !== "unissued")
          throw Error("Local nonissuance requires its fixed source CAS");
        if (previous.phase === "unissued" && !equal(previous, entry))
          throw Error("Immutable local nonissuance changed");
        if (previous.phase === "prepared" && entry.phase !== "prepared")
          throw Error("Original coordinator delivery requires its fixed source CAS");
        for (const field of ["kind", "operationKey", "operation", "attempt"] as const)
          if (!equal(previous[field], entry[field]))
            throw Error("Immutable managed operation changed");
        if (
          (previous.fingerprint && entry.fingerprint !== previous.fingerprint) ||
          (previous.deadlineAt && entry.deadlineAt !== previous.deadlineAt) ||
          (previous.operationId && entry.operationId !== previous.operationId)
        )
          throw Error("Immutable normalized identity changed");
        const merged = {
          ...previous,
          ...entry,
          cursor: Math.max(previous.cursor, entry.cursor),
          events: Math.max(previous.events, entry.events),
          bytes: Math.max(previous.bytes, entry.bytes),
          truncated: previous.truncated || entry.truncated,
        };
        if (previous.terminal) {
          Object.assign(merged, previous);
          merged.cursor = Math.max(previous.cursor, entry.cursor);
        }
        if (previous.receiptDelivery?.state === "confirmed")
          merged.receiptDelivery = previous.receiptDelivery;
        else if (previous.receiptDelivery && entry.receiptDelivery) {
          const { state: _a, ...a } = previous.receiptDelivery,
            { state: _b, ...b } = entry.receiptDelivery;
          if (!equal(a, b)) throw Error("Terminal receipt delivery identity changed");
          merged.receiptDelivery = entry.receiptDelivery;
        }
        if (mapped.has(key)) {
          eventDelta += Math.max(0, entry.events - previous.events);
          byteDelta += Math.max(0, entry.bytes - previous.bytes);
        }
        if (merged.terminal) delete merged.outcome;
        operations[key] = merged;
      }
      for (const [address, mapping] of Object.entries(next.steps))
        if (!equal(old.steps[address], mapping))
          throw Error("Stable step mapping changed outside reservation");
      mergedProjection = {
        ...old,
        version: 3,
        operations,
        eventTotal: Math.min(
          ADMIN_JOB_LOG_LIMITS.events,
          Math.max(old.eventTotal, next.eventTotal, old.eventTotal + eventDelta),
        ),
        byteTotal: Math.min(
          ADMIN_JOB_LOG_LIMITS.bytes,
          Math.max(old.byteTotal, next.byteTotal, old.byteTotal + byteDelta),
        ),
        truncated:
          old.truncated ||
          next.truncated ||
          old.eventTotal + eventDelta >= ADMIN_JOB_LOG_LIMITS.events ||
          old.byteTotal + byteDelta >= ADMIN_JOB_LOG_LIMITS.bytes,
      };
    }
    const {
      opsProjection: _p,
      _execution: _e,
      _parentExecution: _parent,
      _observationLeaseUntil: _lease,
      ...patch
    } = candidate;
    const changed = admissionKey
      ? {}
      : Object.fromEntries(
          Object.entries(patch).filter(([key, value]) => !equal(value, baseline[key])),
        );
    if (
      changed._configurationMaintenanceDecision !== undefined &&
      !equal(current._configurationMaintenanceDecision, changed._configurationMaintenanceDecision)
    )
      throw Error("Immutable configuration decision changed outside its owned transaction");
    if (
      changed._configurationMaintenanceSteps !== undefined &&
      !equal(current._configurationMaintenanceSteps, changed._configurationMaintenanceSteps)
    )
      throw Error("Frozen maintenance steps changed outside their owned transaction");
    if (
      changed._configurationMaintenanceSettle !== undefined &&
      !equal(current._configurationMaintenanceSettle, changed._configurationMaintenanceSettle)
    )
      throw Error("Immutable maintenance settlement changed outside its owned transaction");
    if (
      changed._configurationMaintenanceRollback !== undefined &&
      !equal(current._configurationMaintenanceRollback, changed._configurationMaintenanceRollback)
    )
      throw Error("Known maintenance rollback changed outside its fixed producer");
    const merged = {
      ...current,
      ...changed,
      ...(maintenanceDecisionAttempt
        ? { _configurationMaintenanceDecision: maintenanceDecisionAttempt }
        : {}),
      ...(maintenanceSettleAttempt
        ? { _configurationMaintenanceSettle: maintenanceSettleAttempt }
        : {}),
      _opsLogEvents: current._opsLogEvents ?? old.eventTotal,
      _opsLogBytes: current._opsLogBytes ?? old.byteTotal,
      ...(admissionKey
        ? { _parentExecution: current._parentExecution ?? candidate._parentExecution }
        : {}),
      opsProjection: mergedProjection,
    };
    const [updated] = await tx
      .update(adminJob)
      .set({ result: merged, ...(progress === undefined ? {} : { progress }) })
      .where(jobOwnership(id, execution, ["running", "cancel_pending"]))
      .returning({ result: adminJob.result });
    if (!updated) throw new JobOwnershipLost();
    return { result: updated.result as Record<string, unknown> };
  });
  if ("conflict" in result) throw new JobStepAllocationConflict(result.result);
  if ("capacity" in result) throw new JobStepCapacityExceeded();
  return result.result;
}
