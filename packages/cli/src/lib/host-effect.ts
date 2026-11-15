import { createHash, randomBytes, randomUUID } from "node:crypto";
import { agentStoreLeases, TargetBusyError } from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { runsInAgent } from "./agent-integrations";
import { dockerDaemonReachable } from "./docker";
import { log } from "./output";
import { repoPaths } from "./paths";

export class HostTargetsBusyError extends Error {}

type Outcome = "committed" | "contained" | "unknown";

/** A shell's exit code of 128 or more means the command was killed by a signal. */
function exitOutcome(code: number): Outcome {
  return code === 0 ? "committed" : code >= 128 ? "unknown" : "contained";
}

/** A process killed, timed out or cut off from the daemon did not report how far it got. */
function thrownOutcome(error: unknown): Outcome {
  const value = error as { signal?: unknown; timedOut?: unknown; isTerminated?: unknown };
  return value?.signal || value?.timedOut === true || value?.isTerminated === true
    ? "unknown"
    : "contained";
}

/**
 * Runs one host Docker effect that changes containers (stop, restart, compose
 * up or down, a backup that stops services) under a lease on its targets in
 * the agent's store, which the CLI writes under the store's lock. A held
 * target refuses it before the effect, naming the holder. An effect that
 * ended with a reported failure releases the lease with a failed result; one
 * killed by a signal, timed out, or cut off from the Docker daemon keeps it
 * held for `openmapx control resolve`, as does a CLI killed during the effect.
 */
export async function withHostTargets<T>(
  input: {
    kind: string;
    targets: readonly string[] | "all";
    budgetMs?: number;
    /** How the effect's result ended, for effects that report an exit code. */
    outcomeOf?: (result: T) => Outcome;
  },
  run: () => Promise<T>,
): Promise<T> {
  // A fixed command the agent started runs under the lease the agent holds.
  if (runsInAgent() && process.env.OPENMAPX_CONTROL_EXECUTION) return run();
  const targets = input.targets === "all" ? await registeredServiceIds() : input.targets;
  const leases = agentStoreLeases(repoPaths().infraDir, "host-cli");
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
  const finish = async (outcome: Outcome) => {
    // A command that failed because the daemon went away may have run in part.
    if (outcome === "contained" && !(await dockerDaemonReachable())) outcome = "unknown";
    const known = outcome !== "unknown";
    await leases.settle({
      leaseId: lease.leaseId,
      key: null,
      settlement: {
        identity: owner,
        outcome,
        publication: known ? "committed" : "unknown",
        terminalReceiptDigest: createHash("sha256")
          .update(canonicalJson({ kind: input.kind, outcome }))
          .digest("hex"),
      },
    });
    if (known) await leases.release({ leaseId: lease.leaseId });
    else
      log.err(
        `The outcome of ${input.kind} is unknown; its targets stay held. Check the containers, then run \`openmapx control resolve --op ${owner.operationKey} --as committed|failed\`.`,
      );
  };
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await finish(thrownOutcome(error));
    throw error;
  }
  await finish(input.outcomeOf ? input.outcomeOf(result) : "committed");
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
    return await withHostTargets({ kind, targets, outcomeOf: exitOutcome }, run);
  } catch (error) {
    if (!(error instanceof HostTargetsBusyError)) throw error;
    log.err(error.message);
    return 1;
  }
}
