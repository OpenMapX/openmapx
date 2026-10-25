import { opsOperationSchema } from "../ops/contract";
import type { ExecutionRef, VerifiedParentExecution } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
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
    operation: unknown;
    operationKey: string;
    operationFingerprint: string;
    requestedDeadlineAt?: number;
  },
) {
  const state = installationState(installation);
  const operation = opsOperationSchema.parse(input.operation);
  // These are the fixed container effects implemented by docker-runtime. Restart
  // does not start dependencies; promotion explicitly uses --no-deps. Other
  // adapters need their own manifest/generation resolver before being enabled.
  const targets = (() => {
    switch (operation.kind) {
      case "motis.primary.stop":
      case "motis.primary.restart":
      case "motis.primary.promote":
        return ["motis"];
      case "motis.staging.stop":
      case "motis.staging.restart":
        return ["motis-staging"];
      case "feedProxy.validateAndReload":
        return ["motis-feed-proxy"];
      default:
        throw Error("Receiving target resolver unavailable for this control operation");
    }
  })();
  if (
    installation.role !== "ops-agent" ||
    operation.kind !== input.kind ||
    opsOperationFingerprint(operation) !== input.operationFingerprint
  )
    throw Error("Receiving typed operation mismatch");
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
  if (targets.some((id) => !state.registeredTargets.has(id) || !inspected.serviceIds.includes(id)))
    throw Error("Grant does not contain operation-derived target closure");
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
