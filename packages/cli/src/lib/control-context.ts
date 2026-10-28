import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  adoptArtifactTargetLease,
  assertArtifactTargetLeaseForward,
  type BorrowedArtifactTargetLease,
  beginFixedCliExecution,
  bindBorrowedControlExecution,
  type ControlInstallation,
  closeArtifactTargetLeaseHandle,
  closeControlInstallation,
  openFixedChildInstallation,
  readFixedCliSpawnIntent,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  settleArtifactTargetLeaseChild,
  type VerifiedExecutionAuthority,
  verifiedParentForArtifactDelegation,
  verifyControlEffectSettlement,
  verifyFixedCliControlPeer,
  verifyParentExecution,
} from "@openmapx/core/build-artifacts";
import { executionRefSchema } from "@openmapx/core/ops";
import { repoPaths } from "./paths";

const contexts = new AsyncLocalStorage<{
  authority: VerifiedExecutionAuthority;
  installation: ControlInstallation;
  lease?: BorrowedArtifactTargetLease;
}>();
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
  const delegation = process.env.OPENMAPX_CONTROL_DELEGATION,
    parentAssertion = process.env.OPENMAPX_PARENT_EXECUTION;
  if (!delegation && !parentAssertion) return run();
  if (delegation && parentAssertion) throw Error("Ambiguous fixed CLI control authority");
  const encoded = process.env.OPENMAPX_CONTROL_EXECUTION;
  if (!encoded || Buffer.byteLength(encoded) > 2048)
    throw Error("Missing bounded fixed CLI execution");
  const execution = executionRefSchema.parse(JSON.parse(encoded));
  const assertion = delegation ?? parentAssertion;
  if (!assertion) throw Error("Missing fixed CLI control assertion");
  if (assertion.length > 4096) throw Error("Fixed CLI assertion exceeds header budget");
  const infraDir = repoPaths().infraDir;
  const installation = openFixedChildInstallation({
    infraDir,
    assertion,
    container: existsSync("/run/secrets/openmapx-control-verifiers"),
  });
  let lease: BorrowedArtifactTargetLease | undefined;
  try {
    const intent = readFixedCliSpawnIntent(installation, execution, args);
    const peer = verifyFixedCliControlPeer(installation, {
      assertion,
      execution,
      kind: intent.operation.kind,
    });
    let parent: ReturnType<typeof verifyParentExecution> | undefined;
    if (delegation) {
      parent = verifiedParentForArtifactDelegation(installation, assertion, execution);
      lease = await adoptArtifactTargetLease({
        dataRoot: join(infraDir, "data"),
        assertion,
        peer,
        execution,
        serviceIds: intent.serviceIds,
      });
    } else {
      parent = verifyParentExecution(assertion, peer, {
        execution,
        kind: intent.operation.kind,
        requestedDeadlineAt: execution.deadlineAt,
      });
    }
    // The lease grant's parent is verified in admission; role fingerprints were checked by the fixed runner.
    const authority = retainAdmittedControlExecution(installation, {
      execution,
      kind: intent.operation.kind,
      operation: intent.operation,
      admittedAt: intent.admittedAt,
      ...(parent ? { parent } : {}),
      serviceIds: intent.serviceIds,
      plan: intent.plan,
      ...(intent.reservations ? { reservations: intent.reservations } : {}),
    });
    beginFixedCliExecution(installation, execution);
    if (lease) bindBorrowedControlExecution(lease, authority);
    if (lease) assertArtifactTargetLeaseForward(lease);
    try {
      let result: T;
      try {
        result = await contexts.run({ authority, lease, installation }, run);
      } catch (e) {
        if (e instanceof FixedCliCommandExit && e.code === 0) result = undefined as T;
        else throw e;
      }
      if (process.exitCode && Number(process.exitCode) !== 0)
        throw Error("Fixed CLI command failed");
      retainControlEffectReceipt(authority, {
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
      retainControlEffectReceipt(authority, {
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
  authority: VerifiedExecutionAuthority,
  run: () => Promise<T>,
): Promise<T> {
  if (contexts.getStore()) throw Error("Existing CLI control context");
  return contexts.run({ installation, authority }, run);
}
