import { opsOperationSchema } from "../ops/contract";
import type { ExecutionRef, VerifiedParentExecution } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import { verifiedParentOrigins, verifiedParents } from "../ops/verified-parent-internal";
import {
  type ControlInstallation,
  type ControlTransportPrincipal,
  controlDigest,
  controlHeaders,
  inspectRemoteDelegation,
  installationState,
  parseControlAssertion,
  retainedControlParent,
  verifiedRemoteParentExecution,
  verifyControlPeer,
} from "./control-authority";
import { adoptArtifactTargetLease, inspectArtifactDelegation } from "./target-lease";
/**
 * The agent's receiver for data-manager's delegated operations. The child was
 * recorded in the agent's own lease store when data-manager asked for it; this
 * checks the request against that row. Transport auth and resource policy stay.
 */
export function inspectControlAdmission(
  installation: ControlInstallation,
  input: {
    rawHeaders: readonly string[];
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
  const { delegation } = controlHeaders(input.rawHeaders);
  if (!delegation) throw Error("Missing control assertion");
  const inspected = inspectArtifactDelegation({ assertion: delegation, installation });
  if (
    inspected.kind !== input.kind ||
    inspected.execution.operationKey !== input.operationKey ||
    inspected.execution.operationFingerprint !== input.operationFingerprint ||
    inspected.execution.deadlineAt !== input.requestedDeadlineAt ||
    inspected.execution.executor !== installation.role ||
    inspected.owner.executor !== "data-manager"
  )
    throw Error("Recorded admission mismatch");
  if (
    operation.kind === "transitousLock.approve" &&
    (inspected.phase !== "paired-pin-commit" || inspected.owner.executor !== "data-manager")
  )
    throw Error("Original paired activation leaf required");
  if (targets.some((id) => !state.registeredTargets.has(id) || !inspected.serviceIds.includes(id)))
    throw Error("Delegation does not contain operation-derived target closure");
  const peer = verifyControlPeer(installation, {
    rawHeaders: input.rawHeaders,
    transportPrincipal: input.transportPrincipal,
    execution: inspected.execution,
    kind: input.kind,
  });
  const parent = Object.freeze(retainedControlParent(inspected.parent)) as VerifiedParentExecution;
  verifiedParents.add(parent);
  verifiedParentOrigins.set(parent, parseControlAssertion(delegation).origin);
  return Object.freeze({
    ...inspected,
    parent,
    async adopt(execution: ExecutionRef) {
      if (controlDigest(execution) !== controlDigest(inspected.execution))
        throw Error("Normalized execution identity differs from delegation");
      return adoptArtifactTargetLease({
        assertion: delegation,
        peer,
        execution,
        serviceIds: inspected.serviceIds,
      });
    },
  });
}

/** Data-manager's receiver for executions the agent or the host CLI issued.
 * The caller's token says who sent them; the delegation or parent names them. */
export function inspectDataExecutionAdmission(
  installation: ControlInstallation,
  input: {
    rawHeaders: readonly string[];
    input: import("../services/data-manager/contracts/executions").DataExecutionInput;
    transportPrincipal: Exclude<ControlTransportPrincipal, "data-manager">;
    operationKey: string;
    operationFingerprint: string;
    requestedDeadlineAt?: number;
  },
) {
  if (installation.role !== "data-manager") throw Error("Data-manager receiver required");
  const headers = controlHeaders(input.rawHeaders);
  if (!headers.parent && !headers.delegation) return null;
  if (headers.parent) {
    const { parent, execution } = verifiedRemoteParentExecution(installation, headers.parent, {
      transportPrincipal: input.transportPrincipal,
      operationKey: input.operationKey,
      operationFingerprint: input.operationFingerprint,
      kind: input.input.kind,
      requestedDeadlineAt: input.requestedDeadlineAt,
    });
    return Object.freeze({
      execution,
      parent,
      serviceIds: [] as string[],
      async adopt(adopted: ExecutionRef) {
        if (controlDigest(adopted) !== controlDigest(execution))
          throw Error("Normalized data child differs from parent");
        return undefined;
      },
    });
  }
  const delegation = inspectRemoteDelegation(
    installation,
    input.rawHeaders,
    input.transportPrincipal,
  );
  if (
    input.input.kind !== "generation-hardlinks" ||
    delegation.kind !== input.input.kind ||
    delegation.execution.operationKey !== input.operationKey ||
    delegation.execution.operationFingerprint !== input.operationFingerprint ||
    delegation.execution.deadlineAt !== input.requestedDeadlineAt
  )
    throw Error("Unsupported or mismatched delegated data leaf");
  const local = installationState(installation);
  local.registeredTargets = new Set([...local.registeredTargets, ...delegation.serviceIds]);
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
