import { retainOwnedDataTransitCandidate } from "@openmapx/core/build-artifacts";
import {
  type DataOpsChildPhase,
  DataOpsObservationPending,
  reserveOwnedProxyRecovery,
  runOwnedDataOpsOperation,
} from "../execution/ops-children.js";
import type { FreshDataChildReservation } from "../execution/store.js";
import { DataPublicationUnknown, publishDataChange } from "../execution/worker-scope.js";
import type { JobContext } from "./types.js";
export async function transitOwnedPhase(ctx: JobContext, phase: DataOpsChildPhase) {
  const context = ctx.executionContext;
  if (!context) throw Error("Durable transit ownership is required");
  const record = await context.record(),
    child = record.reservations.find((slot) => slot.phase === phase);
  if (!child) throw Error("Transit phase is not in the original reservation");
  return { context, child };
}
export async function retainTransitPhaseCandidate(
  ctx: JobContext,
  phase: DataOpsChildPhase,
): Promise<void> {
  const { context, child } = await transitOwnedPhase(ctx, phase);
  retainOwnedDataTransitCandidate(context.authority, child);
}
export async function runTransitOwnedPhase(
  ctx: JobContext,
  phase: DataOpsChildPhase,
  reservedContinuation?: FreshDataChildReservation,
) {
  const { context, child } = await transitOwnedPhase(ctx, phase);
  return runOwnedDataOpsOperation(child.operation, {
    context,
    phase,
    ordinal: child.ordinal,
    serviceIds: child.serviceIds,
    ...(reservedContinuation ? { reservedContinuation } : {}),
  });
}
export async function reserveTransitProxyRecovery(
  ctx: JobContext,
  backupDigest: string,
): Promise<FreshDataChildReservation> {
  if (!ctx.executionContext) throw Error("Original proxy recovery owner missing");
  return reserveOwnedProxyRecovery(ctx.executionContext, backupDigest);
}
export function assertTransitForward(ctx: JobContext): void {
  ctx.abortSignal.throwIfAborted();
  if (!ctx.executionContext) throw Error("Durable transit ownership is required");
  ctx.executionContext.assertForward();
}
export function preserveTransitPending(ctx: JobContext, error: unknown): void {
  if (error instanceof DataOpsObservationPending || error instanceof DataPublicationUnknown)
    throw error;
  ctx.abortSignal.throwIfAborted();
}

export async function publishTransitChange<T>(
  ctx: JobContext,
  run: () => T | Promise<T>,
): Promise<T> {
  assertTransitForward(ctx);
  return publishDataChange(() => {
    assertTransitForward(ctx);
    return run();
  });
}
