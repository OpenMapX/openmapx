/** Actual queued API producer/reconciler. Only its owning test controls HTTP
 * reply delivery and kills this native process; no DB/service/authority mocks. */

import { createHmac, randomUUID } from "node:crypto";
import { constants, readFileSync, renameSync, writeFileSync } from "node:fs";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { sql } from "../../../db";
import { handleServiceBulkJob } from "../../admin-job-handlers";
import { serviceApply } from "../../admin-ops";
import { jobRunner } from "../../job-runner";
import { initServiceRegistry } from "../../service-registry";
import { handleSystemUpdateJob } from "../../system-maintenance";

let body = "";
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body) as {
  action: "apply" | "update" | "release" | "platform-release" | "reconcile";
  operationKey?: string;
  applyInput?: unknown;
  actorId?: string;
  releaseId?: string;
  manifestDigest?: string;
  jobId?: string;
  serviceIds?: string[];
  noDeps?: boolean;
  filesystemFault?: "after-retirement-unlink" | "before-candidate-write" | "after-candidate-sync";
};
if (
  input.filesystemFault !== undefined &&
  input.filesystemFault !== "after-retirement-unlink" &&
  input.filesystemFault !== "before-candidate-write" &&
  input.filesystemFault !== "after-candidate-sync"
)
  throw Error("Invalid fixture edge");
if (input.filesystemFault === "after-retirement-unlink") {
  const unlink = filesystem.unlink,
    directory = join(process.env.OPS_TRUSTED_CONFIG_DIR!, ".candidates") + "/";
  filesystem.unlink = async (path) => {
    const candidate = String(path).startsWith(directory) ? readFileSync(path) : undefined;
    await unlink(path);
    if (candidate) {
      const marker = join(process.env.OPENMAPX_ROOT_DIR!, "coordinator-retirement-unlinked");
      writeFileSync(`${marker}.partial`, candidate, { mode: 0o600, flag: "wx" });
      renameSync(`${marker}.partial`, marker);
      await new Promise<void>(() => {});
    }
  };
  syncBuiltinESMExports();
}
if (input.filesystemFault === "before-candidate-write") {
  const open = filesystem.open,
    directory = join(process.env.OPS_TRUSTED_CONFIG_DIR!, ".candidates") + "/";
  filesystem.open = (async (path, flags, ...rest) => {
    if (
      String(path).startsWith(directory) &&
      typeof flags === "number" &&
      (flags & constants.O_EXCL) !== 0
    ) {
      writeFileSync(
        join(process.env.OPENMAPX_ROOT_DIR!, "coordinator-candidate-write-paused"),
        "paused",
      );
      await new Promise<void>(() => {});
    }
    return open(path, flags, ...rest);
  }) as typeof filesystem.open;
  syncBuiltinESMExports();
}
if (input.filesystemFault === "after-candidate-sync") {
  const open = filesystem.open,
    directory = join(process.env.OPS_TRUSTED_CONFIG_DIR!, ".candidates") + "/";
  filesystem.open = (async (path, flags, ...rest) => {
    const handle = await open(path, flags, ...rest);
    if (
      String(path).startsWith(directory) &&
      typeof flags === "number" &&
      (flags & constants.O_EXCL) !== 0
    ) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        writeFileSync(
          join(process.env.OPENMAPX_ROOT_DIR!, "coordinator-candidate-sync-paused"),
          "paused",
        );
        await new Promise<void>(() => {});
      };
    }
    return handle;
  }) as typeof filesystem.open;
  syncBuiltinESMExports();
}
let exit = 2;
try {
  await initServiceRegistry({ strict: true });
  jobRunner.register("service.apply", async (ctx) => ({
    service: ctx.payload.service,
    action: "apply",
    ...(await serviceApply(ctx.payload.service as string, ctx)),
  }));
  jobRunner.register("service.bulk", handleServiceBulkJob);
  jobRunner.register("system.update", handleSystemUpdateJob);
  let id: string;
  if (input.action === "reconcile") {
    if (typeof input.jobId !== "string" || !/^[a-f0-9-]{36}$/.test(input.jobId))
      throw Error("Invalid fixture job");
    id = input.jobId;
    await jobRunner.reconcile({ limit: 1 });
  } else {
    if (input.action === "platform-release") {
      // Synthetic test-only session from Better Auth's real adapter and signer.
      // No production credentials, service mocks or direct job enqueue path.
      const { auth } = await import("../../../auth");
      const { adminPlatformRoute } = await import("../../../routes/admin-platform");
      const { default: Fastify } = await import("fastify");
      if (!input.actorId || !input.operationKey) throw Error("Invalid fixture actor");
      const context = await auth.$context;
      const session = await context.internalAdapter.createSession(input.actorId);
      if (!session) throw Error("Fixture session unavailable");
      const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
        .update(session.token)
        .digest("base64");
      const app = Fastify();
      await app.register(adminPlatformRoute, { prefix: "/api" });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/admin/platform/configuration/apply",
          headers: {
            "content-type": "application/json",
            "idempotency-key": input.operationKey,
            cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
          },
          payload: input.applyInput as Record<string, unknown>,
        });
        if (response.statusCode !== 202)
          throw Error(`Fixture public apply refused: ${response.statusCode}`);
        id = response.json().jobId;
      } finally {
        await app.close();
      }
    } else if (input.action === "release") {
      if (
        typeof input.actorId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(input.actorId) ||
        typeof input.releaseId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.releaseId) ||
        typeof input.manifestDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.manifestDigest)
      )
        throw Error("Invalid fixture release");
      id = await jobRunner.enqueue(
        "system.update",
        {
          operation: "apply",
          workflow: "guarded-release",
          createBackup: false,
          releaseId: input.releaseId,
          expectedDigest: input.manifestDigest,
        },
        input.actorId,
      );
    } else {
      if (input.action !== "apply" && input.action !== "update")
        throw Error("Invalid fixture action");
      id =
        input.action === "apply"
          ? await jobRunner.enqueueMaintenance(
              "service.apply",
              { service: "data-manager" },
              "loopback",
              randomUUID(),
            )
          : await jobRunner.enqueue("service.bulk", {
              action: "update",
              serviceIds: input.serviceIds ?? ["data-manager"],
              ...(input.noDeps ? { noDeps: true } : {}),
            });
    }
    process.stdout.write(JSON.stringify({ event: "queued", jobId: id }) + "\n");
    const until = Date.now() + 240000;
    for (;;) {
      const [row] = await sql`SELECT status FROM admin_job WHERE id=${id}`;
      if (row && ["success", "failed", "canceled"].includes(row.status)) break;
      if (Date.now() >= until) throw Error("Fixture observation expired");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const [row] = await sql`SELECT status FROM admin_job WHERE id=${id}`;
  process.stdout.write(
    JSON.stringify({ event: "result", status: row?.status ?? "missing" }) + "\n",
  );
  exit = row?.status === "success" ? 0 : 2;
  await new Promise((resolve) => setTimeout(resolve, 0));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      event: "result",
      state: "refused",
      errorClass: error instanceof Error ? error.name : "unknown",
    }) + "\n",
  );
} finally {
  await sql.end({ timeout: 2 });
}
process.exit(exit);
