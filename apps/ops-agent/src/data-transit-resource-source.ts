import {
  type ControlInstallation,
  inspectDataTransitCandidate,
} from "@openmapx/core/build-artifacts";
import { opsOperationFingerprint } from "@openmapx/core/ops";
import type { TrustedOpsDataSource } from "./policy";
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
