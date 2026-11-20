import type { OpsClient } from "../ops/client";
import { type OpsOperation, type OpsResultFor, parseOpsResult } from "../ops/contract";
import type { LeaseBackend } from "./lease-store";
import { TargetBusyError } from "./lease-store";

export type LeaseOperation = Extract<
  OpsOperation,
  { kind: "lease.acquire" | "lease.read" | "lease.update" }
>;
/** Sends one lease operation to the agent and returns its typed result. */
export type LeaseSender = (operation: LeaseOperation) => Promise<unknown>;
/** Lease operations over the agent's HTTP route, with the caller's own token. */
export function opsClientLeaseSender(client: OpsClient | (() => OpsClient)): LeaseSender {
  return async (operation) => {
    const submitted = await (typeof client === "function" ? client() : client).execute(operation);
    if (submitted.execution !== "sync") throw Error("Lease operations answer at once");
    return submitted.value;
  };
}

/**
 * Leases through the agent, for data-manager. Every call is a typed agent
 * operation under data-manager's own token; the agent applies the same rules
 * as to its own leases and refuses another principal's.
 */
export function remoteLeaseBackend(send: LeaseSender): LeaseBackend {
  async function run<K extends LeaseOperation["kind"]>(
    operation: Extract<LeaseOperation, { kind: K }>,
  ): Promise<OpsResultFor<K>> {
    return parseOpsResult(operation.kind, await send(operation)) as OpsResultFor<K>;
  }
  const update = async (
    leaseId: string,
    action: Extract<OpsOperation, { kind: "lease.update" }>["action"],
  ) => (await run({ kind: "lease.update", leaseId, action })).lease;
  return {
    async acquire(input) {
      const result = await run({
        kind: "lease.acquire",
        owner: input.owner,
        ownerKind: input.ownerKind,
        targets: [...input.targets].sort(),
      });
      if (result.outcome === "busy") throw new TargetBusyError(result.target, result.holder);
      return result.lease;
    },
    read: async (leaseId) => (await run({ kind: "lease.read", leaseId })).lease ?? undefined,
    async delegate(input) {
      const lease = await update(input.leaseId, { action: "delegate", child: input.child });
      if (!lease) throw Error("Target lease is not held");
      return lease;
    },
    async settle(input) {
      const lease = await update(input.leaseId, {
        action: "settle",
        key: input.key,
        settlement: input.settlement,
      });
      if (!lease) throw Error("Target lease is not held");
      return lease;
    },
    cancel: async (input) =>
      (await update(input.leaseId, { action: "cancel", key: input.key })) ?? undefined,
    release: async (input) => {
      await update(input.leaseId, { action: "release" });
    },
  };
}
