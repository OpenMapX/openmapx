import type { OpsRuntime } from "../runtime";
import type { ArtifactTransferStore } from "./store";
export function installArtifactTransferRuntime(
  runtime: OpsRuntime,
  store: ArtifactTransferStore,
): void {
  runtime["artifactTransfer.validate"] = (_operation, context) =>
    store.validatePreparedArtifact(context);
  runtime["artifactTransfer.create"] = ({ kind: _, ...input }) => store.createStage(input);
  runtime["artifactTransfer.list"] = (op) => store.listStages(op);
  runtime["artifactTransfer.inspect"] = (op) => store.getStage(op);
  runtime["artifactTransfer.delete"] = async (op) => {
    await store.deleteStage(op);
    return { deleted: true };
  };
  runtime["artifactTransfer.claim"] = (op) => store.claimStage(op);
  runtime["artifactTransfer.inspectClaim"] = (op) => store.inspectClaim(op);
  runtime["artifactTransfer.settle"] = (op) => store.settleStageClaim(op);
}
