import { opsOperationSchema } from "../ops/contract";
import type { ExecutionRef } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import { type ControlInstallation, controlDigest } from "./control-records";
import {
  type ControlDelegation,
  type ControlTransportPrincipal,
  inspectRemoteDelegation,
  type LeaseChildRef,
  verifyControlPeer,
} from "./execution-record";
import { installationState } from "./private-records";
import {
  adoptArtifactTargetLease,
  inspectArtifactDelegation,
  verifiedParentForArtifactDelegation,
} from "./target-lease";
/**
 * The agent's receiver for data-manager's delegated operations. The child was
 * recorded in the agent's own lease store when data-manager asked for it; this
 * checks the request against that row. Transport auth and resource policy stay.
 */
export function inspectControlAdmission(
  installation: ControlInstallation,
  input: {
    leaseChild: LeaseChildRef;
    transportPrincipal: ControlTransportPrincipal;
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
      case "transitousLock.approve":
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
  const inspected = inspectArtifactDelegation({ leaseChild: input.leaseChild, installation });
  if (
    inspected.kind !== input.kind ||
    inspected.execution.operationKey !== input.operationKey ||
    inspected.execution.operationFingerprint !== input.operationFingerprint ||
    inspected.execution.deadlineAt !== input.requestedDeadlineAt ||
    inspected.execution.executor !== installation.role ||
    inspected.owner.executor !== "data-manager"
  )
    throw Error("Recorded admission mismatch");
  if (operation.kind === "transitousLock.approve" && inspected.phase !== "paired-pin-commit")
    throw Error("Original paired activation leaf required");
  if (targets.some((id) => !state.registeredTargets.has(id) || !inspected.serviceIds.includes(id)))
    throw Error("Delegation does not contain operation-derived target closure");
  const peer = verifyControlPeer(installation, {
    leaseChild: input.leaseChild,
    transportPrincipal: input.transportPrincipal,
    execution: inspected.execution,
    kind: input.kind,
  });
  const parent = verifiedParentForArtifactDelegation(
    installation,
    input.leaseChild,
    inspected.execution,
  );
  return Object.freeze({
    ...inspected,
    parent,
    async adopt(execution: ExecutionRef) {
      if (controlDigest(execution) !== controlDigest(inspected.execution))
        throw Error("Normalized execution identity differs from delegation");
      return adoptArtifactTargetLease({ peer, execution, serviceIds: inspected.serviceIds });
    },
  });
}

/** Data-manager's receiver for executions the agent or the host CLI issued.
 * The caller's token says who sent them; the delegation names them. */
export function inspectDataExecutionAdmission(
  installation: ControlInstallation,
  input: {
    delegation?: ControlDelegation;
    input: import("../services/data-manager/contracts/executions").DataExecutionInput;
    transportPrincipal: Exclude<ControlTransportPrincipal, "data-manager">;
    operationKey: string;
    operationFingerprint: string;
    requestedDeadlineAt?: number;
  },
) {
  if (installation.role !== "data-manager") throw Error("Data-manager receiver required");
  if (!input.delegation) return null;
  const delegation = inspectRemoteDelegation(
    installation,
    input.delegation,
    input.transportPrincipal,
  );
  if (
    delegation.kind !== input.input.kind ||
    delegation.execution.operationKey !== input.operationKey ||
    delegation.execution.operationFingerprint !== input.operationFingerprint ||
    delegation.execution.deadlineAt !== input.requestedDeadlineAt ||
    (delegation.leaseId === null) === (input.input.kind === "generation-hardlinks")
  )
    throw Error("Unsupported or mismatched delegated data leaf");
  if (delegation.leaseId !== null) {
    const local = installationState(installation);
    local.registeredTargets = new Set([...local.registeredTargets, ...delegation.serviceIds]);
  }
  return Object.freeze({
    execution: delegation.execution,
    parent: delegation.verifiedParent,
    serviceIds: delegation.serviceIds,
    async adopt(execution: ExecutionRef) {
      if (controlDigest(execution) !== controlDigest(delegation.execution))
        throw Error("Normalized data child differs from delegation");
      return undefined;
    },
  });
}
