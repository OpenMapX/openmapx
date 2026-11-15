import {
  type ControlInstallation,
  controlRegisteredServiceIds,
  type LeaseRecord,
  type LeaseStore,
  leaseRules,
  TargetBusyError,
  verifyFiniteControlEdge,
} from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  type OpsOperation,
  type OpsResultFor,
  type OpsRole,
} from "@openmapx/core/ops";
import { childPhaseKinds } from "../../../packages/core/src/build-artifacts/control-child-records";

type LeaseOperation = Extract<
  OpsOperation,
  { kind: "lease.acquire" | "lease.read" | "lease.update" | "lease.settleChild" }
>;

/**
 * Leases data-manager holds through the agent. It sees and changes only
 * leases its own executions own, and the same rules apply as to the agent's
 * leases: one admission path, children recorded before they start, release
 * only once everything has a known outcome. It also reports the outcome of a
 * child it ran under the agent's or the host CLI's lease.
 */
export async function runLeaseOperation(
  installation: ControlInstallation,
  store: LeaseStore,
  role: OpsRole,
  operation: LeaseOperation,
): Promise<OpsResultFor<LeaseOperation["kind"]>> {
  if (role !== "data-manager") throw new LeaseRefused();
  const owned = (lease: LeaseRecord | undefined) =>
    lease && lease.owner.executor === role ? lease : undefined;
  const now = Date.now();
  if (operation.kind === "lease.settleChild") {
    if (operation.settlement.identity.executor !== role) throw new LeaseRefused();
    return {
      lease:
        (await store.update((leases) => leaseRules.settleChild(leases, operation.settlement))) ??
        null,
    };
  }
  if (operation.kind === "lease.acquire") {
    const registered = new Set(controlRegisteredServiceIds(installation));
    if (
      operation.owner.executor !== role ||
      operation.targets.some((target) => !registered.has(target))
    )
      throw new LeaseRefused();
    try {
      const lease = await store.update((leases) => leaseRules.acquire(leases, operation, now));
      return { outcome: "acquired", lease };
    } catch (error) {
      if (!(error instanceof TargetBusyError)) throw error;
      const { leaseId, owner, ownerKind, state } = error.holder;
      return {
        outcome: "busy",
        target: error.target,
        holder: { leaseId, owner, ownerKind, state },
      };
    }
  }
  if (operation.kind === "lease.read")
    return { lease: owned(store.get(operation.leaseId)) ?? null };
  const lease = await store.update((leases) => {
    const current = owned(leases.find((value) => value.leaseId === operation.leaseId));
    if (!current) {
      if (operation.action.action === "release" || operation.action.action === "cancel")
        return undefined;
      throw new LeaseRefused();
    }
    const action = operation.action;
    switch (action.action) {
      case "delegate": {
        const child = action.child;
        const edges = verifyFiniteControlEdge(
          role,
          current.ownerKind,
          child.phase as never,
          child.recipient,
        );
        if (
          child.parentKey !== null ||
          child.depth !== 1 ||
          child.recipient !== "ops-agent" ||
          canonicalJson(child.parent) !== canonicalJson(current.owner) ||
          canonicalJson(child.permittedFurtherEdges) !== canonicalJson(edges) ||
          !(childPhaseKinds as Record<string, readonly string[]>)[child.phase]?.includes(
            child.kind,
          ) ||
          child.execution.deadlineAt > current.owner.deadlineAt
        )
          throw new LeaseRefused();
        return leaseRules.delegate(leases, { leaseId: current.leaseId, child }, now);
      }
      case "settle": {
        // Data-manager's children are the agent's own operations, which settle themselves.
        if (action.key !== null) throw new LeaseRefused();
        return leaseRules.settle(leases, { leaseId: current.leaseId, ...action });
      }
      case "cancel":
        return leaseRules.cancel(leases, { leaseId: current.leaseId, key: action.key });
      case "release":
        leaseRules.release(leases, { leaseId: current.leaseId });
        return undefined;
    }
  });
  return { lease: lease ?? null };
}

export class LeaseRefused extends Error {
  constructor() {
    super("Lease operation is not permitted");
  }
}
