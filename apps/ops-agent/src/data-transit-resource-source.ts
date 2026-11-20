import {
  type ControlInstallation,
  inspectDataTransitCandidate,
} from "@openmapx/core/build-artifacts";
import { isTrustedConfigurationApplyOperation, opsOperationFingerprint } from "@openmapx/core/ops";
import type { TrustedOpsDataSource } from "./policy";

/** A configuration apply carries its payload beside the operation, which names it by digest. */
export const configurationPayloadSource: TrustedOpsDataSource = {
  claim: async (operation, _fingerprint, signal, owner) =>
    isTrustedConfigurationApplyOperation(operation) && owner?.role === "api" && !signal.aborted
      ? { revisionId: operation.revisionId, values: {} }
      : null,
};
/** The existing registry claimer still performs its kind/service policy. This
 * finite source supplies only DM's authenticated, confined transit candidate. */
export function createDataTransitTrustedOpsDataSource(
  installation: ControlInstallation | undefined,
  configuration: TrustedOpsDataSource,
): TrustedOpsDataSource {
  return {
    async claim(operation, fingerprint, signal, owner) {
      if (
        operation.kind !== "motis.primary.promote" &&
        operation.kind !== "feedProxy.validateAndReload"
      )
        return configuration.claim(operation, fingerprint, signal, owner);
      if (
        !installation ||
        signal.aborted ||
        owner?.role !== "data-manager" ||
        fingerprint !== opsOperationFingerprint(operation)
      )
        return null;
      try {
        const checked = inspectDataTransitCandidate(installation, owner.operationKey, operation);
        signal.throwIfAborted();
        return {
          revisionId: `data-candidate-${checked.digest}`,
          values: { candidateDigest: checked.digest },
        };
      } catch {
        return null;
      }
    },
  };
}
