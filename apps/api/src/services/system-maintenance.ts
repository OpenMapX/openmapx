import type { OpsResultFor } from "@openmapx/core/ops";
import { executeAdminJobOperation } from "./admin-job-ops";
import type { JobContext } from "./job-runner";
import {
  type ApiOpsClient,
  ApiOpsError,
  createApiOpsClient,
  createDurableOpsKey,
} from "./ops-client";

const AGENT_HANDOFF_TIMEOUT_MS = 10 * 60_000;
const AGENT_HANDOFF_POLL_MS = 2_000;
// The agent records a handoff before it starts the helper. After a lost
// `agent.update` result, a reachable agent without that record never started one.
const AGENT_HANDOFF_ABSENT_MS = 10_000;
// The agent stops shortly after starting its replacement, so the operation's
// result can be lost in transit. These classes say nothing about whether it ran.
const AMBIGUOUS_AGENT_UPDATE_ERRORS = new Set(["runtime", "timeout", "recovery_required"]);

export interface SystemUpdateJobDependencies {
  client?: ApiOpsClient;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function handleSystemUpdateJob(
  ctx: JobContext,
  dependencies: SystemUpdateJobDependencies = {},
): Promise<Record<string, unknown>> {
  const payload = ctx.payload as {
    operation?: "check" | "apply";
    createBackup?: boolean;
    releaseId?: string;
    expectedDigest?: string;
  };
  // A check reads only the small release manifest. Images are downloaded by
  // an update, while the running services keep serving.
  if (payload.operation === "check") {
    await ctx.setProgress(10);
    const release = await executeAdminJobOperation(
      ctx,
      { kind: "release.resolve" },
      "admin-job.release.resolve",
    );
    await ctx.setProgress(60);
    const inspection = await executeAdminJobOperation(
      ctx,
      { kind: "release.inspect" },
      "admin-job.release.inspect",
    );
    await ctx.setProgress(100);
    return { operation: "check", release: release.releaseId, ...inspection };
  }
  if (payload.operation !== "apply") throw new Error("Unsupported system update operation");

  if (
    !payload.releaseId ||
    typeof payload.expectedDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.expectedDigest)
  )
    throw new Error("Check a release before applying it");
  await ctx.setProgress(5);
  await executeAdminJobOperation(
    ctx,
    { kind: "release.pull", releaseId: payload.releaseId },
    "admin-job.release.pull",
  );
  await ctx.setProgress(45);
  await replaceAgentIfNeeded(ctx, payload.releaseId, payload.expectedDigest, dependencies);
  await ctx.setProgress(60);
  const createBackup = payload.createBackup !== false;
  const result = await executeAdminJobOperation(
    ctx,
    {
      kind: "system.update",
      releaseId: payload.releaseId,
      expectedDigest: payload.expectedDigest,
      createBackup,
      ...(createBackup ? { backupId: `pre-update-${ctx.jobId}` } : {}),
    },
    "admin-job.system.update",
  );
  await ctx.setProgress(100);
  return { operation: "apply", release: result.releaseId, phase: "complete" };
}

/**
 * Updates the operations agent before the application services, as its own
 * step: the agent starts a helper that replaces its container, verifies the
 * new agent and restores the previous one if it does not start.
 */
async function replaceAgentIfNeeded(
  ctx: JobContext,
  releaseId: string,
  expectedDigest: string,
  dependencies: SystemUpdateJobDependencies,
): Promise<void> {
  // Derived from the job, so a resumed job and a lost result both find it.
  const handoffId = createDurableOpsKey("admin-job.agent.handoff", ctx.jobId);
  let resultLost = false;
  try {
    const result = await executeAdminJobOperation(
      ctx,
      { kind: "agent.update", releaseId, expectedDigest, handoffId },
      "admin-job.agent.update",
    );
    if (!result.replaced) return;
  } catch (error) {
    if (error instanceof ApiOpsError && error.errorClass === "busy") {
      throw new Error(
        "Other operations are running on the operations agent. Update again when they finish.",
      );
    }
    if (!(error instanceof ApiOpsError) || !AMBIGUOUS_AGENT_UPDATE_ERRORS.has(error.errorClass)) {
      throw error;
    }
    resultLost = true;
  }
  await ctx.log("Replacing the operations agent before the application services");

  const client = dependencies.client ?? createApiOpsClient();
  const sleep =
    dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? Date.now;
  const deadline = now() + AGENT_HANDOFF_TIMEOUT_MS;
  let absentSince: number | undefined;
  for (let attempt = 0; ; attempt += 1) {
    const handoff = await inspectHandoff(client, ctx, handoffId, attempt);
    if (handoff?.phase === "applied") {
      await ctx.log("The new operations agent is running");
      return;
    }
    if (handoff?.phase === "rolled_back" || handoff?.phase === "failed") {
      const checkpoint = { ...ctx.checkpointResult, errorCode: "host_update_required" };
      await ctx.checkpoint(checkpoint);
      ctx.checkpointResult = checkpoint;
      throw new Error(
        `The operations agent could not be replaced${
          handoff.phase === "rolled_back" ? " and the previous agent was restored" : ""
        }${handoff.reason ? `: ${handoff.reason}` : ""}`,
      );
    }
    if (handoff?.phase === "none") {
      absentSince ??= now();
      if (resultLost && now() - absentSince >= AGENT_HANDOFF_ABSENT_MS) {
        throw new ApiOpsError("runtime");
      }
    }
    if (now() >= deadline) {
      throw new Error("The operations agent replacement did not finish in time");
    }
    await sleep(AGENT_HANDOFF_POLL_MS);
  }
}

/** Undefined while the agent is unreachable, which is expected during its restart. */
async function inspectHandoff(
  client: ApiOpsClient,
  ctx: JobContext,
  handoffId: string,
  attempt: number,
): Promise<OpsResultFor<"agent.handoff.inspect"> | undefined> {
  try {
    const result = await client.execute(
      { kind: "agent.handoff.inspect", handoffId },
      {
        operationKey: createDurableOpsKey(
          "admin-job.agent.handoff.inspect",
          `${ctx.jobId}:${attempt}`,
        ),
        signal: ctx.signal,
      },
    );
    return result.execution === "sync" ? result.value : undefined;
  } catch {
    if (ctx.signal.aborted) throw new Error("System update canceled");
    return undefined;
  }
}

export async function handleSystemDiagnosticsJob(
  ctx: JobContext,
): Promise<Record<string, unknown>> {
  await ctx.log("Running deep service and in-network probes…");
  const result = await executeAdminJobOperation(
    ctx,
    { kind: "system.diagnostics" },
    "admin-job.system.diagnostics",
  );
  return { operation: "diagnostics", ok: result.ok, checks: result.checks };
}
