import { executeAdminJobOperation } from "./admin-job-ops";
import type { JobContext } from "./job-runner";
export async function handleSystemUpdateJob(ctx: JobContext): Promise<Record<string, unknown>> {
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
  if (ctx.payload.workflow !== "guarded-release") {
    const { JobObservationPending } = await import("./admin-job-failure");
    throw new JobObservationPending("recovery_required");
  }
  const { runGuardedSystemRelease } = await import("./system-release-application");
  return runGuardedSystemRelease(ctx);
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
