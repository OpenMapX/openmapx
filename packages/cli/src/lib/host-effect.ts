import { createHash, randomBytes, randomUUID } from "node:crypto";
import { TargetBusyError } from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { runsInAgent } from "./agent-integrations";
import { hostCliLeases } from "./host-leases";
import { log } from "./output";
import { repoPaths } from "./paths";

export class HostTargetsBusyError extends Error {}

/**
 * Runs one host Docker effect that changes containers (stop, restart, compose
 * up or down, a backup that stops services) under a lease on its targets, the
 * same admission path the agent uses. A held target refuses it before the
 * effect, naming the holder. A finished effect releases the lease whether it
 * succeeded or failed; a CLI killed during the effect leaves it held for
 * `openmapx control`.
 */
export async function withHostTargets<T>(
  input: { kind: string; targets: readonly string[] | "all"; budgetMs?: number },
  run: () => Promise<T>,
): Promise<T> {
  // A fixed command the agent started runs under the lease the agent holds.
  if (runsInAgent() && process.env.OPENMAPX_CONTROL_EXECUTION) return run();
  const targets = input.targets === "all" ? await registeredServiceIds() : input.targets;
  const leases = hostCliLeases(repoPaths().infraDir);
  const deadlineAt = Date.now() + (input.budgetMs ?? 2 * 3600_000);
  const body = { kind: input.kind, targets: [...new Set(targets)].sort() };
  const operationFingerprint = createHash("sha256").update(canonicalJson(body)).digest("hex");
  const owner: ExecutionRef = {
    executor: "host-cli",
    principal: "host-cli",
    executionId: randomUUID(),
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({ kind: input.kind, operationFingerprint, deadlineAt }),
  };
  let lease: Awaited<ReturnType<typeof leases.acquire>>;
  try {
    lease = await leases.acquire({ owner, ownerKind: input.kind, targets: body.targets });
  } catch (error) {
    if (error instanceof TargetBusyError) throw new HostTargetsBusyError(error.message);
    throw error;
  }
  const finish = async (outcome: "committed" | "contained", receipt: unknown) => {
    await leases.settle({
      leaseId: lease.leaseId,
      key: null,
      settlement: {
        identity: owner,
        outcome,
        publication: "committed",
        terminalReceiptDigest: createHash("sha256").update(canonicalJson(receipt)).digest("hex"),
      },
    });
    await leases.release({ leaseId: lease.leaseId });
  };
  let result: T;
  try {
    result = await run();
  } catch (error) {
    // The effect ran to its end and failed: its outcome is known.
    await finish("contained", { kind: input.kind, failed: true });
    throw error;
  }
  await finish("committed", { kind: input.kind, failed: false });
  return result;
}

/** Every registered service, for effects that may touch any container. */
export async function registeredServiceIds(): Promise<string[]> {
  const registry = new services.ServiceRegistry({ rootDir: repoPaths().root });
  await registry.load();
  return registry
    .list()
    .map((service) => service.manifest.id)
    .sort();
}

/** A host command's Docker effect under a lease; a held target exits 1 with the holder named. */
export async function leasedHostEffect(
  kind: string,
  targets: readonly string[] | "all",
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await withHostTargets({ kind, targets }, run);
  } catch (error) {
    if (!(error instanceof HostTargetsBusyError)) throw error;
    log.err(error.message);
    return 1;
  }
}
