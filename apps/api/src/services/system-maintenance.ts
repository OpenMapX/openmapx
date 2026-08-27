import { executeAdminJobOperation } from "./admin-job-ops";
import type { JobContext } from "./job-runner";

export async function handleSystemUpdateJob(ctx: JobContext): Promise<Record<string, unknown>> {
  const payload = ctx.payload as { operation?: "check" | "apply"; createBackup?: boolean };
  if (payload.operation === "check") {
    await ctx.setProgress(10);
    const release = await executeAdminJobOperation(
      ctx,
      { kind: "release.resolve" },
      "admin-job.release.resolve",
    );
    await ctx.setProgress(35);
    await executeAdminJobOperation(
      ctx,
      { kind: "release.pull", releaseId: release.releaseId },
      "admin-job.release.pull",
    );
    await ctx.setProgress(80);
    const inspection = await executeAdminJobOperation(
      ctx,
      { kind: "release.inspect" },
      "admin-job.release.inspect",
    );
    await ctx.setProgress(100);
    return { operation: "check", release: release.releaseId, ...inspection };
  }
  if (payload.operation !== "apply") throw new Error("Unsupported system update operation");

  const release = await executeAdminJobOperation(
    ctx,
    { kind: "release.resolve" },
    "admin-job.release.resolve",
  );
  await ctx.setProgress(10);
  const createBackup = payload.createBackup !== false;
  const result = await executeAdminJobOperation(
    ctx,
    {
      kind: "system.update",
      releaseId: release.releaseId,
      createBackup,
      ...(createBackup ? { backupId: `pre-update-${ctx.jobId}` } : {}),
    },
    "admin-job.system.update",
  );
  await ctx.setProgress(100);
  return { operation: "apply", release: result.releaseId, phase: "complete" };
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
