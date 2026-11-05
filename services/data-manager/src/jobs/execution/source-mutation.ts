import { join } from "node:path";
import { assertArtifactTargetLeaseForward, controlDigest } from "@openmapx/core/build-artifacts";
import type { DataExecutionInput } from "@openmapx/core/data-manager-contracts";
import { prepareTransitSourceMutation } from "../../transit-sources.js";
import { resolveTransitOverlayPath } from "../transitous/internal.js";
import type { MotisOperationsPolicy } from "../transitous/operations-profile.js";
import type { DataExecutionContext } from "./runtime.js";
import { dataExecutionWorkerContext, publishDataChange } from "./worker-scope.js";
/** Fixed first phase of the original transit-sync, not an HTTP-side mutation. */
export async function publishOwnedTransitSourceMutation(
  input: Extract<DataExecutionInput, { kind: "transit-sync" }>,
  context: DataExecutionContext,
  policy: MotisOperationsPolicy,
  dataDir: string,
): Promise<void> {
  if (!input.sourceMutation) return;
  if (dataExecutionWorkerContext() !== context) throw Error("Owned transit worker required");
  context.assertForward();
  assertArtifactTargetLeaseForward(context.targetAuthority);
  const retained = await context.record();
  if (
    retained.input.kind !== "transit-sync" ||
    controlDigest(retained.input) !== controlDigest(input) ||
    controlDigest(retained.execution) !== controlDigest(context.execution)
  )
    throw Error("Original transit mutation identity required");
  const mutation = prepareTransitSourceMutation(
    {
      catalogDir: join(dataDir, ".transitous-catalog"),
      overlayPath: resolveTransitOverlayPath(dataDir),
      countries: policy.countries,
    },
    input.sourceMutation,
  );
  await publishDataChange(() => {
    context.assertForward();
    assertArtifactTargetLeaseForward(context.targetAuthority);
    mutation.persist();
  });
}
