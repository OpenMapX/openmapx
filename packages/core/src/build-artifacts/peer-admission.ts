import { opsOperationSchema } from "../ops/contract";
import type { ExecutionRef, VerifiedParentExecution } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import { verifiedParentOrigins, verifiedParents } from "../ops/verified-parent-internal";
import {
  type ControlInstallation,
  controlDigest,
  controlHeaders,
  installationState,
  readParentGrant,
  retainedControlParent,
  verifyControlPeer,
  verifyParentExecution,
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
  if (inspected.origin) verifiedParentOrigins.set(parent, inspected.origin);
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
  if (inspected.origin) verifiedParentOrigins.set(parent, inspected.origin);
  return parent;
}

/** Fixed DM receiver: the only proposed ID comes from the authenticated grant.
 * Reading the grant is observation; normalized equality is checked at adoption. */
export function inspectDataExecutionAdmission(
  installation: ControlInstallation,
  input: {
    rawHeaders: readonly string[];
    input: import("../services/data-manager/contracts/executions").DataExecutionInput;
    operationKey: string;
    operationFingerprint: string;
    requestedDeadlineAt?: number;
  },
) {
  const local = installationState(installation),
    headers = controlHeaders(input.rawHeaders);
  if (installation.role !== "data-manager") throw Error("Data-manager receiver required");
  if (!headers.parent && !headers.delegation) return null;
  if (headers.parent) {
    const grant = readParentGrant(local, headers.parent),
      assertion = headers.parent;
    if (
      grant.recipient !== "data-manager" ||
      grant.child.executor !== "data-manager" ||
      grant.kind !== input.input.kind ||
      grant.child.operationKey !== input.operationKey ||
      grant.child.operationFingerprint !== input.operationFingerprint ||
      grant.child.deadlineAt !== input.requestedDeadlineAt
    )
      throw Error("Signed data parent identity mismatch");
    const peer = verifyControlPeer(installation, {
      rawHeaders: input.rawHeaders,
      transportPrincipal: "shared-data-manager-bearer",
      execution: grant.child,
      kind: grant.kind,
    });
    const parent = verifyParentExecution(assertion, peer, {
      execution: grant.child,
      kind: grant.kind,
      requestedDeadlineAt: grant.child.deadlineAt,
    });
    return Object.freeze({
      execution: grant.child,
      parent,
      serviceIds: [] as string[],
      async adopt(execution: ExecutionRef) {
        if (controlDigest(execution) !== controlDigest(grant.child))
          throw Error("Normalized data child differs from grant");
        return undefined;
      },
    });
  }
  const assertion = headers.delegation!;
  const grant = inspectArtifactDelegation({ dataRoot: local.dataRoot, assertion, installation });
  if (
    input.input.kind !== "generation-hardlinks" ||
    grant.kind !== input.input.kind ||
    grant.execution.executor !== "data-manager" ||
    grant.execution.operationKey !== input.operationKey ||
    grant.execution.operationFingerprint !== input.operationFingerprint ||
    grant.execution.deadlineAt !== input.requestedDeadlineAt
  )
    throw Error("Unsupported or mismatched borrowed data leaf");
  const peer = verifyControlPeer(installation, {
    rawHeaders: input.rawHeaders,
    transportPrincipal: "shared-data-manager-bearer",
    execution: grant.execution,
    kind: grant.kind,
  });
  const parent = verifiedParentForArtifactDelegation(installation, assertion, grant.execution);
  return Object.freeze({
    execution: grant.execution,
    parent,
    serviceIds: [] as string[],
    async adopt(execution: ExecutionRef) {
      if (controlDigest(execution) !== controlDigest(grant.execution))
        throw Error("Normalized data child differs from grant");
      const lease = await adoptArtifactTargetLease({
        dataRoot: local.dataRoot,
        assertion,
        peer,
        execution,
        serviceIds: grant.serviceIds,
      });
      local.registeredTargets = new Set([...local.registeredTargets, ...lease.serviceIds]);
      return lease;
    },
  });
}
