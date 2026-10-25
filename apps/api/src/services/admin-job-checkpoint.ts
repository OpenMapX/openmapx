import { canonicalJson } from "@openmapx/core/ops";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { readProjection } from "./admin-job-ops";
import {
  ADMIN_JOB_LOG_LIMITS,
  type JobExecution,
  JobOwnershipLost,
  JobStepAllocationConflict,
  JobStepCapacityExceeded,
  jobOwnership,
} from "./admin-job-state";

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
        operation.phase !== "admitting" ||
        operation.terminal
      )
        throw Error("Invalid stable step reservation");
      if (old.steps[stepAddress] || old.operations[stepAddress] || old.operations[admissionKey])
        return { conflict: true as const, result: current };
      if (Object.keys(old.steps).length >= 64 || Object.keys(old.operations).length >= 64)
        return { capacity: true as const, result: current };
      if (row.status !== "running" || current._cancelRequestedAt) throw new JobOwnershipLost();
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
    const merged = {
      ...current,
      ...changed,
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
