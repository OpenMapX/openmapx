import type { ExecutionRef, VerifiedParentExecution } from "../ops/execution-identity";
import { verifiedParents } from "../ops/verified-parent-internal";
import {
  type ControlInstallation,
  controlDigest,
  controlHeaders,
  installationState,
  retainedControlParent,
  verifyControlPeer,
} from "./control-authority";
import { adoptArtifactTargetLease, inspectArtifactDelegation } from "./target-lease";
/** Both receivers keep transport auth and resource policy. This verifies only the exact signed internal attempt. */
export function inspectControlAdmission(
  installation: ControlInstallation,
  input: {
    rawHeaders: readonly string[];
    transportPrincipal: "data-manager" | "shared-data-manager-bearer" | "host-cli";
    kind: string;
    operationKey: string;
    operationFingerprint: string;
    requestedDeadlineAt?: number;
  },
) {
  const state = installationState(installation);
  const { delegation } = controlHeaders(input.rawHeaders);
  if (!delegation) throw Error("Missing control assertion");
  const inspected = inspectArtifactDelegation({
    dataRoot: state.dataRoot,
    assertion: delegation,
    installation,
  });
  if (
    inspected.kind !== input.kind ||
    inspected.execution.operationKey !== input.operationKey ||
    inspected.execution.operationFingerprint !== input.operationFingerprint ||
    inspected.execution.deadlineAt !== input.requestedDeadlineAt ||
    inspected.execution.executor !== installation.role
  )
    throw Error("Signed immutable admission mismatch");
  const peer = verifyControlPeer(installation, {
    rawHeaders: input.rawHeaders,
    transportPrincipal: input.transportPrincipal,
    execution: inspected.execution,
    kind: input.kind,
  });
  const parent = Object.freeze(retainedControlParent(inspected.parent)) as VerifiedParentExecution;
  verifiedParents.add(parent);
  return Object.freeze({
    ...inspected,
    parent,
    async adopt(execution: ExecutionRef) {
      if (controlDigest(execution) !== controlDigest(inspected.execution))
        throw Error("Normalized execution identity differs from grant");
      return adoptArtifactTargetLease({
        dataRoot: state.dataRoot,
        assertion: delegation,
        peer,
        execution,
        serviceIds: inspected.serviceIds,
      });
    },
  });
}
export function verifiedParentForArtifactDelegation(
  installation: ControlInstallation,
  assertion: string,
  execution: ExecutionRef,
): VerifiedParentExecution {
  const state = installationState(installation);
  const inspected = inspectArtifactDelegation({
    dataRoot: state.dataRoot,
    assertion,
    installation,
  });
  if (controlDigest(inspected.execution) !== controlDigest(execution))
    throw Error("Wrong delegated execution");
  const parent = Object.freeze(retainedControlParent(inspected.parent)) as VerifiedParentExecution;
  verifiedParents.add(parent);
  return parent;
}
