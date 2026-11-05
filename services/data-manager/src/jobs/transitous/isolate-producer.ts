/** The original transit owner detaches mutable build inputs from active/rollback generations. */
import {
  assertArtifactTargetLeaseExecution,
  assertArtifactTargetLeaseForward,
  controlDigest,
  executionAuthorityState,
} from "@openmapx/core/build-artifacts";
import { isolateArtifactHardlinks } from "../../../../../packages/core/src/build-artifacts/copy-tree";
import { AnchoredDirectory } from "../../../../../packages/core/src/build-artifacts/filesystem";
import type { DataExecutionContext } from "../execution/runtime";
import { dataExecutionWorkerContext, publishDataChange } from "../execution/worker-scope";

export async function isolateOwnedTransitProducer(
  context: DataExecutionContext,
  minimumFreeBytes: number,
): Promise<void> {
  if (dataExecutionWorkerContext() !== context) throw Error("Original transit worker required");
  context.assertForward();
  const owner = executionAuthorityState(context.authority),
    record = await context.record();
  assertArtifactTargetLeaseForward(context.targetAuthority);
  assertArtifactTargetLeaseExecution(context.targetAuthority, context.execution);
  if (
    owner.installation.installation.role !== "data-manager" ||
    !["transit-sync", "catalog.validate"].includes(owner.kind) ||
    controlDigest(record.execution) !== controlDigest(owner.execution) ||
    controlDigest(record.input) !== owner.execution.operationFingerprint ||
    context.targetAuthority.mode !== "owner" ||
    !["motis", "motis-staging", "motis-feed-proxy"].every((id) =>
      context.targetAuthority.serviceIds.includes(id),
    )
  )
    throw Error("Original complete transit target owner required");
  const data = new AnchoredDirectory(owner.installation.dataRoot);
  let producer: AnchoredDirectory | undefined;
  try {
    try {
      producer = data.directory("gtfs");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const source = producer;
    await publishDataChange(() =>
      isolateArtifactHardlinks({
        source,
        minimumFreeBytes,
        signal: context.signal,
        maximumEntries: 100000,
        maximumBytes: Number.MAX_SAFE_INTEGER,
        maximumManifestBytes: 64 * 1024 * 1024,
      }),
    );
    // A canceled copy has settled and only identical producer bytes were published.
    // Record that containment before the original cancellation stops the pipeline.
    context.assertForward();
  } finally {
    producer?.close();
    data.close();
  }
}
