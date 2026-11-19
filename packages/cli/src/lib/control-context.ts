import { AsyncLocalStorage } from "node:async_hooks";
import {
  adoptArtifactTargetLease,
  assertArtifactTargetLeaseForward,
  assertControlExecutionForward,
  type BorrowedArtifactTargetLease,
  beginFixedCliExecution,
  bindBorrowedControlExecution,
  type ControlInstallation,
  closeArtifactTargetLeaseHandle,
  closeControlInstallation,
  type ExecutionHandle,
  openFixedChildInstallation,
  pruneControlRecords,
  readFixedCliSpawnIntent,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  retainDataUpdatePlan,
  settleArtifactTargetLeaseChild,
  verifiedParentForArtifactDelegation,
  verifiedRetainedControlParent,
  verifyControlEffectSettlement,
  verifyFixedCliControlPeer,
} from "@openmapx/core/build-artifacts";
import { executionRefSchema } from "@openmapx/core/ops";
import { z } from "zod";
import { repoPaths } from "./paths";

const fixedChildSchema = z.strictObject({
  leaseId: z.uuid().nullable(),
  childKey: z.uuid(),
});
const contexts = new AsyncLocalStorage<{
  authority: ExecutionHandle;
  installation: ControlInstallation;
  lease?: BorrowedArtifactTargetLease;
  dataWorkflowInitial?: import("@openmapx/core/ops").DataWorkflowReceipt;
  dataUpdatePlan?: import("@openmapx/core/build-artifacts").DataUpdatePlan;
}>();

/** Short-lived standalone commands prune their own finished control records.
 * Fixed children do not call this; their parent prunes. */
export async function pruneHostControlRecords(installation: ControlInstallation): Promise<void> {
  try {
    await pruneControlRecords(installation);
  } catch (error) {
    process.stderr.write(`Control record prune failed: ${String(error)}\n`);
  }
}
class FixedCliCommandExit extends Error {
  constructor(readonly code: number) {
    super(`Fixed CLI command exited with code ${code}`);
  }
}
/** Exit classification only; it conveys no containment or execution proof. */
export function fixedCliCommandExitCode(error: unknown): number | undefined {
  return error instanceof FixedCliCommandExit ? error.code : undefined;
}
/** Managed commands unwind through durable child settlement before the process exits. */
export function completeCliCommand(code = 0): never {
  if (contexts.getStore()) throw new FixedCliCommandExit(code);
  process.exit(code);
}
export function cliControlContext() {
  return contexts.getStore();
}
export async function withCliControlContext<T>(
  args: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const named = process.env.OPENMAPX_CONTROL_CHILD;
  if (!named) return run();
  if (Buffer.byteLength(named) > 1024) throw Error("Fixed CLI child exceeds its budget");
  const child = fixedChildSchema.parse(JSON.parse(named));
  const encoded = process.env.OPENMAPX_CONTROL_EXECUTION;
  if (!encoded || Buffer.byteLength(encoded) > 2048)
    throw Error("Missing bounded fixed CLI execution");
  const execution = executionRefSchema.parse(JSON.parse(encoded));
  const infraDir = repoPaths().infraDir;
  const installation = openFixedChildInstallation({ infraDir, child });
  let lease: BorrowedArtifactTargetLease | undefined;
  try {
    const intent = readFixedCliSpawnIntent(installation, execution, args);
    let parent: ReturnType<typeof verifiedParentForArtifactDelegation>;
    if (child.leaseId !== null) {
      const leaseChild = { leaseId: child.leaseId, childKey: child.childKey };
      parent = verifiedParentForArtifactDelegation(installation, leaseChild, execution);
      lease = await adoptArtifactTargetLease({
        peer: verifyFixedCliControlPeer(installation, {
          leaseChild,
          execution,
          kind: intent.operation.kind,
        }),
        execution,
        serviceIds: intent.serviceIds,
      });
    } else {
      // The parent recorded this child's spawn in its own private state.
      parent = verifiedRetainedControlParent(installation, intent.parent);
    }
    // The lease grant's parent is verified in admission; role fingerprints were checked by the fixed runner.
    const authority = await retainAdmittedControlExecution(installation, {
      execution,
      kind: intent.operation.kind,
      operation: intent.operation,
      admittedAt: intent.admittedAt,
      parent,
      ...(child.leaseId !== null
        ? { leaseChild: { leaseId: child.leaseId, childKey: child.childKey } }
        : {}),
      serviceIds: intent.serviceIds,
      plan: intent.plan,
      ...(intent.reservations ? { reservations: intent.reservations } : {}),
    });
    if (intent.dataUpdatePlan) retainDataUpdatePlan(authority, intent.dataUpdatePlan);
    beginFixedCliExecution(installation, execution);
    if (lease) bindBorrowedControlExecution(lease, authority);
    if (lease) assertArtifactTargetLeaseForward(lease);
    try {
      let result: T;
      try {
        result = await contexts.run(
          {
            authority,
            lease,
            installation,
            ...(intent.dataUpdatePlan ? { dataUpdatePlan: intent.dataUpdatePlan } : {}),
            ...(intent.dataWorkflowInitial
              ? { dataWorkflowInitial: intent.dataWorkflowInitial }
              : {}),
          },
          run,
        );
      } catch (e) {
        if (e instanceof FixedCliCommandExit && e.code === 0) result = undefined as T;
        else throw e;
      }
      if (process.exitCode && Number(process.exitCode) !== 0)
        throw Error("Fixed CLI command failed");
      await retainControlEffectReceipt(authority, {
        outcome: "committed",
        publication: "committed",
        receipt: { kind: "fixed-cli-exit", args: [...args], exitCode: 0 },
      });
      if (lease)
        await settleArtifactTargetLeaseChild(
          lease,
          verifyControlEffectSettlement(installation, execution),
        );
      return result;
    } catch (e) {
      await retainControlEffectReceipt(authority, {
        outcome: "unknown",
        publication: "unknown",
        receipt: { kind: "unresolved" },
      });
      if (lease)
        await settleArtifactTargetLeaseChild(
          lease,
          verifyControlEffectSettlement(installation, execution),
        );
      throw e;
    }
  } finally {
    if (lease) closeArtifactTargetLeaseHandle(lease);
    closeControlInstallation(installation);
  }
}

export function withHostDataControlContext<T>(
  installation: ControlInstallation,
  authority: ExecutionHandle,
  run: () => Promise<T>,
): Promise<T> {
  if (contexts.getStore()) throw Error("Existing CLI control context");
  return contexts.run({ installation, authority }, run);
}

/** Restriction at actual host mutation boundaries; observation remains usable
 * after cancellation and cannot acquire authority through this helper. */
export function assertCliControlForward(): void {
  const context = contexts.getStore();
  if (!context) return;
  assertControlExecutionForward(context.authority);
  if (context.lease) assertArtifactTargetLeaseForward(context.lease);
}
