import { type OpsOperation, standaloneInstallReceiptSchema } from "@openmapx/core/ops";
import { and, eq, sql } from "drizzle-orm";
import type { db } from "../../db";
import {
  type adminJob,
  installedExtension,
  installedExtensionComponent,
  installedIntegration,
} from "../../db/schema";
import { readProjection } from "../admin-job-projection";
import { JobOwnershipLost } from "../admin-job-state";
import { readStandaloneState } from "./state";
/** A cancellation can finalize only its own published component. No forward install admission. */
export async function assertStandaloneSettlementCheckpoint(
  row: typeof adminJob.$inferSelect,
  operation: OpsOperation,
  connection: Pick<typeof db, "execute" | "select">,
): Promise<void> {
  if (row.type !== "standalone.install" || operation.kind !== "integration.settle")
    throw new JobOwnershipLost();
  const current = row.result as Record<string, unknown> | null,
    payload = row.payload as Record<string, unknown> | null;
  const state = await readStandaloneState(current?._standalone);
  if (
    state.jobId !== row.id ||
    state.operationId !== payload?.operationId ||
    state.ownerId !== payload.ownerId ||
    state.ownerId !== payload._standaloneActor ||
    state.request.inspectionId !== payload.inspectionId ||
    state.request.expectedContentDigest !== payload.expectedContentDigest ||
    operation.transactionId !== state.operationId ||
    operation.expectedContentDigest !== state.inspection.contentDigest ||
    state.request.expectedContentDigest !== state.inspection.contentDigest ||
    state.request.inspectionId !== state.inspection.inspectionId
  )
    throw new JobOwnershipLost();
  const original = Object.values(readProjection(current).operations).filter(
    (entry) =>
      entry.operation?.kind === "integration.install" &&
      entry.operation.operationId === state.operationId,
  );
  if (original.length !== 1) throw new JobOwnershipLost();
  const source = original[0]!,
    body = source.operation,
    delivery = source.receiptDelivery;
  if (
    source.attempt?.apiJobId !== row.id ||
    body?.kind !== "integration.install" ||
    body.ownerId !== state.ownerId ||
    body.inspectionId !== state.request.inspectionId ||
    body.expectedContentDigest !== state.request.expectedContentDigest ||
    !source.terminal ||
    delivery?.state !== "confirmed" ||
    delivery.terminalReceipt.state !== "succeeded"
  )
    throw new JobOwnershipLost();
  if (
    delivery.terminalReceipt.operationId !== source.operationId ||
    delivery.terminalReceipt.operationKey !== source.operationKey ||
    delivery.terminalReceipt.fingerprint !== source.fingerprint
  )
    throw new JobOwnershipLost();
  const published = standaloneInstallReceiptSchema.parse(delivery.terminalReceipt.result);
  if (
    published.transactionId !== state.operationId ||
    published.integrationId !== state.inspection.integrationId ||
    published.contentDigest !== state.inspection.contentDigest
  )
    throw new JobOwnershipLost();
  await connection.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${"standalone-bookkeeping:" + state.inspection.integrationId},0))`,
  );
  const [parent] = await connection
    .select()
    .from(installedExtension)
    .where(eq(installedExtension.id, state.parentId))
    .for("update");
  const [integration] = await connection
    .select()
    .from(installedIntegration)
    .where(eq(installedIntegration.id, state.inspection.integrationId))
    .for("update");
  const [component] = await connection
    .select()
    .from(installedExtensionComponent)
    .where(
      and(
        eq(installedExtensionComponent.kind, "integration"),
        eq(installedExtensionComponent.componentId, state.inspection.integrationId),
      ),
    )
    .for("update");
  if (operation.decision === "commit") {
    if (
      state.phase !== "persisted" ||
      parent?.lastOperationId !== state.operationId ||
      parent.installationKind !== "standalone" ||
      parent.sourceTrust !== "community" ||
      parent.provenance?.contentDigest !== state.inspection.contentDigest ||
      integration?.managedByExtension !== state.parentId ||
      integration.installedVersion !== state.inspection.version ||
      component?.extensionId !== state.parentId
    )
      throw new JobOwnershipLost();
  } else if (
    state.phase !== "restore" ||
    parent?.lastOperationId === state.operationId ||
    (component && component.extensionId !== state.parentId) ||
    (integration?.managedByExtension && integration.managedByExtension !== state.parentId)
  )
    throw new JobOwnershipLost();
  // The unchanged parent/body/address checks in the caller and actual signed
  // agent transaction independently enforce the original lifetime and ownership.
}

/** Whole-job cancellation is supported by the original successful restore leaf,
 * not by the generic fact that every child returned successfully. */
export async function hasVerifiedStandaloneRestoration(
  result: unknown,
  jobId: string | undefined,
): Promise<boolean> {
  try {
    if (!jobId || !result || typeof result !== "object") return false;
    const value = result as Record<string, unknown>;
    if (
      value._standaloneSettled !== true ||
      typeof value._cancelRequestedAt !== "string" ||
      !Number.isFinite(Date.parse(value._cancelRequestedAt))
    )
      return false;
    const state = await readStandaloneState(value._standalone);
    if (state.jobId !== jobId || state.phase !== "complete" || state.outcome !== "restored")
      return false;
    const operations = Object.values(readProjection(value).operations);
    if (
      operations.some(
        (operation) => !operation.terminal || operation.receiptDelivery?.state !== "confirmed",
      )
    )
      return false;
    const restore = operations.filter(
      (operation) =>
        operation.operation?.kind === "integration.settle" &&
        operation.operation.transactionId === state.operationId,
    );
    if (restore.length !== 1) return false;
    const operation = restore[0]!,
      body = operation.operation,
      receipt = operation.receiptDelivery!.terminalReceipt;
    return (
      body?.kind === "integration.settle" &&
      body.decision === "restore" &&
      body.expectedContentDigest === state.inspection.contentDigest &&
      receipt.state === "succeeded" &&
      receipt.kind === "integration.settle" &&
      receipt.operationKey === operation.operationKey &&
      receipt.fingerprint === operation.fingerprint &&
      (receipt.result as { outcome?: unknown; transactionId?: unknown })?.outcome === "restored" &&
      (receipt.result as { transactionId?: unknown }).transactionId === state.operationId
    );
  } catch {
    return false;
  }
}
