import { canonicalJson, type OpsOperation } from "@openmapx/core/ops";
import type { db } from "../../db";
import type { adminJob } from "../../db/schema";
import { readProjection } from "../admin-job-projection";
import { JobOwnershipLost } from "../admin-job-state";
import { lockOwnership, ownershipSnapshot } from "./ownership-database";
import { readOwnershipState } from "./ownership-state";
export async function assertOwnershipSettlementCheckpoint(
  row: typeof adminJob.$inferSelect,
  operation: OpsOperation,
  connection: Pick<typeof db, "execute" | "select">,
) {
  if (
    !["standalone.adopt", "standalone.remove"].includes(row.type) ||
    operation.kind !== "integration.settle"
  )
    throw new JobOwnershipLost();
  const result = row.result as Record<string, unknown>,
    payload = row.payload as Record<string, unknown>,
    state = await readOwnershipState(result._standalone);
  if (
    state.jobId !== row.id ||
    state.ownerId !== payload.ownerId ||
    state.ownerId !== payload._standaloneActor ||
    state.operationId !== payload.operationId ||
    state.request.integrationId !== payload.integrationId ||
    state.request.expectedContentDigest !== payload.expectedContentDigest ||
    operation.transactionId !== state.operationId ||
    operation.expectedContentDigest !== state.request.expectedContentDigest ||
    !state.inspection?.allowed
  )
    throw new JobOwnershipLost();
  const sources = Object.values(readProjection(result).operations).filter(
    (x) =>
      x.operation?.kind === "integration.inspectOwnership" &&
      x.operation.operationId === state.operationId,
  );
  const source = sources[0],
    receipt = source?.receiptDelivery;
  if (
    sources.length !== 1 ||
    !source?.terminal ||
    source.attempt?.apiJobId !== row.id ||
    receipt?.state !== "confirmed" ||
    receipt.terminalReceipt.state !== "succeeded" ||
    receipt.terminalReceipt.operationKey !== source.operationKey ||
    receipt.terminalReceipt.fingerprint !== source.fingerprint ||
    canonicalJson(receipt.terminalReceipt.result) !== canonicalJson(state.inspection)
  )
    throw new JobOwnershipLost();
  await lockOwnership(connection, state.request.integrationId);
  const current = await ownershipSnapshot(connection, state.request.integrationId);
  if (operation.decision === "commit") {
    if (state.phase !== "persisted") throw new JobOwnershipLost();
    if (state.action === "adopt") {
      if (
        current.parent?.id !== state.parentId ||
        current.parent.lastOperationId !== state.operationId ||
        current.parent.installationKind !== "standalone" ||
        current.integration?.managedByExtension !== state.parentId ||
        current.integration.sourceType !== "legacy_unknown" ||
        current.components.length !== 1 ||
        current.components[0]?.extensionId !== state.parentId
      )
        throw new JobOwnershipLost();
    } else if (current.integration || current.components.length || current.parent)
      throw new JobOwnershipLost();
  } else if (state.phase !== "restore" || canonicalJson(current) !== state.before)
    throw new JobOwnershipLost();
}
