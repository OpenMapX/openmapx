import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoPaths } from "@openmapx/core/server";
import { dockerStatus } from "../utils/docker-compose";
import { executeAdminJobOperation } from "./admin-job-ops";
import type { JobContext } from "./job-runner";
import { createDurableOpsKey } from "./ops-client";
import { prepareServiceGeneration } from "./service-preparation";
import { getServiceRegistry } from "./service-registry";
import { applyTrustedConfiguration } from "./trusted-config-operations";

export type { HardlinkApplySummary } from "@openmapx/core/ops";

// Path resolution for an API running on the host (`pnpm dev`), which can read
// the deployment directly. The app-api container has no host checkout: its
// `/app/infra/docker` holds no configuration, and the deployment reaches it
// through baked environment and typed ops-agent operations instead.
//
// Order of preference:
//   1. `DOCKER_INFRA_DIR` — explicit override.
//   2. `repoPaths()` — `OPENMAPX_ROOT_DIR` or the checkout found by walking up.
//   3. Walk up from this file's location.

function findInfraDir(): string {
  if (process.env.DOCKER_INFRA_DIR) return process.env.DOCKER_INFRA_DIR;
  try {
    return repoPaths().infraDir;
  } catch {
    // `findRepoRoot()` couldn't see a workspace marker (bundled prod build
    // without OPENMAPX_ROOT_DIR set, or running outside the repo tree).
    // Fall back to the relative-walk heuristic.
    const thisFile = fileURLToPath(import.meta.url);
    return join(dirname(thisFile), "..", "..", "..", "..", "infra", "docker");
  }
}

export const INFRA_DIR = findInfraDir();

// Docker availability — checked solely via `docker info`. The generated compose
// file is rendered on demand by `pnpm openmapx compose render` and is not a
// prerequisite for the daemon itself being reachable.

let _dockerCache: boolean | null = null;
let _dockerCacheAt = 0;
const DOCKER_CACHE_TTL = 60_000; // 60 seconds

export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerCache !== null && Date.now() - _dockerCacheAt < DOCKER_CACHE_TTL) return _dockerCache;
  try {
    _dockerCache = (await dockerStatus()).reachable;
  } catch {
    _dockerCache = false;
  }
  _dockerCacheAt = Date.now();
  return _dockerCache;
}

export function resetDockerCache(): void {
  _dockerCache = null;
  _dockerCacheAt = 0;
}

/**
 * Apply the operator's selection with the current config layers (defaults +
 * DB + env) as a new configuration generation. Called before `service.start`
 * so "save config + apply" takes effect without a separate CLI render.
 */
export async function renderAndPersistCompose(options: {
  operationKey: string;
  signal?: AbortSignal;
  ctx?: JobContext;
}): Promise<{ revisionId: string }> {
  const { revisionId } = await applyTrustedConfiguration({ kind: "stack.render", ...options });
  return { revisionId };
}

export { applyGenerationHardlinks } from "./service-preparation";

// Service control (job handlers) — registry-authorized + routed through the
// docker-compose helper that targets the generated compose file.

function assertKnownService(service: string, requireEnabled = true) {
  let svc: ReturnType<ReturnType<typeof getServiceRegistry>["get"]>;
  try {
    svc = getServiceRegistry().get(service);
  } catch {
    throw new Error("Service registry not initialized");
  }
  if (!svc) {
    throw new Error(`Unknown service "${service}" — not present in the service registry`);
  }
  if (requireEnabled && !svc.enabled) {
    throw new Error(`Service "${service}" is disabled in the registry`);
  }
  return svc;
}

async function serviceComposeAction(
  service: string,
  action: "stop" | "restart",
  ctx: JobContext,
): Promise<{ exitCode: number }> {
  assertKnownService(service, action !== "stop");
  // Community and built-in services now take the same typed path: the agent
  // authorizes the id against its own trusted selection, so the API no longer
  // needs a direct-Docker adapter for community lifecycle.
  await ctx.checkpoint({
    ...ctx.checkpointResult,
    _completion: {
      operationKey: createDurableOpsKey(`admin-job.service.${action}`, `${ctx.jobId}:${service}`),
      result: { service, action },
    },
  });
  await executeAdminJobOperation(
    ctx,
    { kind: `service.${action}`, serviceId: service },
    `admin-job.service.${action}`,
    { durableIdentity: service },
  );
  return { exitCode: 0 };
}

export async function serviceStart(service: string, ctx: JobContext): Promise<void> {
  assertKnownService(service);
  const prepared = await prepareServiceGeneration(ctx, `start:${service}`, {
    coordinatorMode: "ensure-running",
  });
  await ctx.checkpoint({
    ...ctx.checkpointResult,
    _completion: {
      operationKey: createDurableOpsKey("admin-job.service.start", `${ctx.jobId}:${service}`),
      result: { service, action: "start" },
    },
  });
  await executeAdminJobOperation(
    ctx,
    {
      kind: "service.start",
      serviceId: service,
      expectedConfigurationRevisionId: prepared.revisionId,
    },
    "admin-job.service.start",
    { durableIdentity: service },
  );
}

export async function serviceApply(service: string, ctx: JobContext) {
  assertKnownService(service);
  if (service === "data-manager")
    return (await import("./service-preparation")).applyCoordinatorService(ctx, null);
  const prepared = await prepareServiceGeneration(ctx, `apply:${service}`, {
    coordinatorMode: "ensure-running",
  });
  await ctx.checkpoint({
    ...ctx.checkpointResult,
    _completion: {
      operationKey: createDurableOpsKey("admin-job.service.recreate", `${ctx.jobId}:${service}`),
      result: { service, action: "recreate" },
    },
  });
  await executeAdminJobOperation(
    ctx,
    {
      kind: "service.recreate",
      serviceId: service,
      expectedConfigurationRevisionId: prepared.revisionId,
    },
    "admin-job.service.recreate",
    { durableIdentity: service },
  );
  return { changed: true as const, revisionId: prepared.revisionId };
}

export async function serviceStop(service: string, ctx: JobContext): Promise<void> {
  await ctx.log(`Stopping ${service}...`);
  const r = await serviceComposeAction(service, "stop", ctx);
  if (r.exitCode !== 0) throw new Error(`docker compose stop exited with ${r.exitCode}`);
  await ctx.log(`${service} stopped.`);
}

export async function serviceRestart(service: string, ctx: JobContext): Promise<void> {
  await ctx.log(`Restarting ${service}...`);
  const r = await serviceComposeAction(service, "restart", ctx);
  if (r.exitCode !== 0) throw new Error(`docker compose restart exited with ${r.exitCode}`);
  await ctx.log(`${service} restarted.`);
}
