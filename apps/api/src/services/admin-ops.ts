import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoPaths } from "@openmapx/core/server";
import {
  type DockerComposeAction,
  dockerComposeAction,
  dockerStatus,
} from "../utils/docker-compose";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import { getServiceRegistry } from "./service-registry";
import { applyTrustedConfiguration } from "./trusted-config-operations";

export interface HardlinkApplySummary {
  applied: boolean;
  linked: number;
  skipped: number;
  pruned: number;
  entries: number;
  via?: string;
}

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
}): Promise<{ revisionId: string }> {
  const { revisionId } = await applyTrustedConfiguration({ kind: "stack.render", ...options });
  return { revisionId };
}

/**
 * Link consumer data directories to their producers as the configuration
 * generation just applied describes. The plan lives in that generation on the
 * host, which only the operations agent can read, so the agent applies it.
 */
export async function applyGenerationHardlinks(opts: {
  revisionId: string;
  operationIdentity: string;
  signal?: AbortSignal;
}): Promise<HardlinkApplySummary> {
  const { entries, linked, skipped, pruned } = await executeAndWait(
    createApiOpsClient(),
    { kind: "stack.link", revisionId: opts.revisionId },
    createDurableOpsKey("admin-job.hardlinks.apply", opts.operationIdentity),
    { signal: opts.signal },
  );
  return { applied: true, entries, linked, skipped, pruned, via: "ops-agent" };
}

// Service control (job handlers) — registry-authorized + routed through the
// docker-compose helper that targets the generated compose file.

function assertKnownService(service: string) {
  let svc: ReturnType<ReturnType<typeof getServiceRegistry>["get"]>;
  try {
    svc = getServiceRegistry().get(service);
  } catch {
    throw new Error("Service registry not initialized");
  }
  if (!svc) {
    throw new Error(`Unknown service "${service}" — not present in the service registry`);
  }
  if (!svc.enabled) {
    throw new Error(`Service "${service}" is disabled in the registry`);
  }
  return svc;
}

async function serviceComposeAction(
  service: string,
  action: Exclude<DockerComposeAction, "recreate-isolated">,
  ctx: JobContext,
): Promise<{ exitCode: number }> {
  assertKnownService(service);
  // Community and built-in services now take the same typed path: the agent
  // authorizes the id against its own trusted selection, so the API no longer
  // needs a direct-Docker adapter for community lifecycle.
  return dockerComposeAction(service, action, {
    operationKey: createDurableOpsKey(`admin-job.service.${action}`, `${ctx.jobId}:${service}`),
    signal: ctx.signal,
  });
}

export async function serviceStart(service: string, ctx: JobContext): Promise<void> {
  assertKnownService(service);
  await ctx.log(`Rendering compose for latest config...`);
  const { revisionId } = await renderAndPersistCompose({
    operationKey: createDurableOpsKey("admin-job.config.render", `${ctx.jobId}:${service}`),
    signal: ctx.signal,
  });
  await ctx.log("Applying hardlinks for the applied configuration...");
  const hardlinks = await applyGenerationHardlinks({
    revisionId,
    operationIdentity: `${ctx.jobId}:${service}`,
    signal: ctx.signal,
  });
  await ctx.log(
    `Hardlinks applied (${hardlinks.linked} linked, ${hardlinks.skipped} already linked, ${hardlinks.pruned} pruned)`,
  );
  await ctx.log(`Starting ${service}...`);
  const r = await serviceComposeAction(service, "start", ctx);
  if (r.exitCode !== 0) throw new Error(`docker compose up exited with ${r.exitCode}`);
  await ctx.log(`${service} started.`);
}

export async function serviceApply(service: string, ctx: JobContext): Promise<void> {
  assertKnownService(service);
  await ctx.log(`Rendering compose for latest config + secrets...`);
  const configurationKind = ctx.payload.configurationKind;
  const { revisionId } =
    configurationKind === "vault"
      ? await applyTrustedConfiguration({
          kind: "vault.apply",
          serviceId: service,
          operationKey: createDurableOpsKey("admin-job.vault.apply", `${ctx.jobId}:${service}`),
          signal: ctx.signal,
        })
      : await renderAndPersistCompose({
          operationKey: createDurableOpsKey("admin-job.config.apply", `${ctx.jobId}:${service}`),
          signal: ctx.signal,
        });
  await ctx.log("Applying hardlinks for the applied configuration...");
  const hardlinks = await applyGenerationHardlinks({
    revisionId,
    operationIdentity: `${ctx.jobId}:${service}`,
    signal: ctx.signal,
  });
  await ctx.log(
    `Hardlinks applied (${hardlinks.linked} linked, ${hardlinks.skipped} already linked, ${hardlinks.pruned} pruned)`,
  );
  await ctx.log(`Applying rendered configuration to ${service}...`);
  const r = await serviceComposeAction(service, "recreate", ctx);
  if (r.exitCode !== 0)
    throw new Error(`docker compose up --force-recreate exited with ${r.exitCode}`);
  await ctx.log(`${service} configuration applied.`);
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
