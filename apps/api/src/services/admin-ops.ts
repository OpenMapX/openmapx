import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createDataManagerTransport,
  getStatus,
  link,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import { repoPaths } from "@openmapx/core/server";
import {
  type DockerComposeAction,
  dockerComposeAction,
  dockerStatus,
} from "../utils/docker-compose";
import { JobObservationPending } from "./admin-job-failure";
import { executeAdminJobOperation } from "./admin-job-ops";
import { JobOwnershipLost } from "./admin-job-state";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";
import { getServiceRegistry } from "./service-registry";
import { applyTrustedConfiguration } from "./trusted-config-operations";

const DATA_MANAGER_STARTUP_TIMEOUT_MS = 60_000;
const DATA_MANAGER_POLL_INTERVAL_MS = 2_000;

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
  ctx?: JobContext;
}): Promise<{ revisionId: string }> {
  const { revisionId } = await applyTrustedConfiguration({ kind: "stack.render", ...options });
  return { revisionId };
}

function dataManagerEnabled(): boolean {
  try {
    const svc = getServiceRegistry().get("data-manager");
    return !!svc?.enabled;
  } catch {
    return false;
  }
}

function dataManagerUrlCandidates(): string[] {
  const out: string[] = [];
  if (process.env.DATA_MANAGER_URL?.trim()) out.push(process.env.DATA_MANAGER_URL.trim());
  // In docker-compose, app-api reaches data-manager over the service DNS name.
  out.push("http://data-manager:4000");
  // Keep localhost fallback for non-container local API runs.
  out.push("http://localhost:4000");
  return [...new Set(out)];
}

async function waitForDataManagerTransport(signal?: AbortSignal): Promise<{
  transport: ReturnType<typeof createDataManagerTransport>;
  url: string;
}> {
  const urls = dataManagerUrlCandidates();
  const deadline = Date.now() + DATA_MANAGER_STARTUP_TIMEOUT_MS;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    for (const url of urls) {
      signal?.throwIfAborted();
      const transport = createDataManagerTransport({
        baseUrl: url,
        authToken: process.env.DATA_MANAGER_AUTH_TOKEN?.trim(),
      });
      try {
        unwrapDataManagerResponse(await getStatus({ transport, signal }));
        signal?.throwIfAborted();
        return { transport, url };
      } catch (err) {
        signal?.throwIfAborted();
        lastErr = err;
      }
    }
    await delay(DATA_MANAGER_POLL_INTERVAL_MS, undefined, { signal });
  }

  const detail = (lastErr as Error | undefined)?.message ?? String(lastErr ?? "unknown error");
  throw new Error(
    `data-manager did not become reachable within ${DATA_MANAGER_STARTUP_TIMEOUT_MS / 1000}s (${urls.join(", ")}): ${detail}`,
  );
}

/**
 * Link consumer data directories to their producers as the configuration
 * generation just applied describes. The plan lives in that generation on the
 * host, which only the operations agent can read; data-manager applies it,
 * because its mounts confine the links and prunes to the data root.
 */
export async function applyGenerationHardlinks(opts: {
  revisionId: string;
  operationIdentity: string;
  log?: (msg: string) => Promise<void> | void;
  signal?: AbortSignal;
  ctx?: JobContext;
}): Promise<HardlinkApplySummary> {
  const signal = opts.ctx?.signal ?? opts.signal;
  signal?.throwIfAborted();
  const attempts = opts.ctx?.checkpointResult?._hardlinkAttempts as
    | Record<string, { revisionId: string; phase: string; result?: HardlinkApplySummary }>
    | undefined;
  const prior = attempts?.[opts.operationIdentity];
  if (prior) {
    if (prior.revisionId !== opts.revisionId || prior.phase !== "complete" || !prior.result)
      throw new JobObservationPending("recovery_required");
    return prior.result;
  }
  if (opts.ctx?.observationOnly) throw new JobObservationPending("recovery_required");
  const { plan } = await executeAndWait(
    createApiOpsClient(),
    { kind: "configuration.hardlinks.inspect", revisionId: opts.revisionId },
    createDurableOpsKey("admin-job.hardlinks.inspect", opts.operationIdentity),
    { signal },
  );
  if (plan.length === 0) {
    return { applied: true, linked: 0, skipped: 0, pruned: 0, entries: 0 };
  }
  if (!dataManagerEnabled()) {
    throw new Error(
      `Hardlink plan contains ${plan.length} entr${plan.length === 1 ? "y" : "ies"}, but service "data-manager" is disabled. Enable data-manager before starting services from Admin, or apply links via CLI first.`,
    );
  }

  await opts.log?.("Ensuring data-manager is running for hardlink apply...");
  signal?.throwIfAborted();
  const coordinatorKey = createDurableOpsKey(
    "admin-job.hardlinks.start",
    `${opts.operationIdentity}:data-manager`,
  );
  if (opts.ctx) {
    await executeAdminJobOperation(
      opts.ctx,
      { kind: "service.start", serviceId: "data-manager" },
      "admin-job.hardlinks.start",
      { operationKey: coordinatorKey },
    );
  } else {
    const dmStart = await dockerComposeAction("data-manager", "start", {
      operationKey: coordinatorKey,
      signal,
    });
    if (dmStart.exitCode !== 0)
      throw new Error(`docker compose up data-manager exited with ${dmStart.exitCode}`);
  }

  await opts.log?.(`Applying hardlink plan (${plan.length} entries, prune enabled)...`);
  const { transport, url } = await waitForDataManagerTransport(signal);
  signal?.throwIfAborted();
  const checkpoint = async (phase: "attempted" | "complete", result?: HardlinkApplySummary) => {
    if (!opts.ctx) return;
    await opts.ctx.checkpoint({
      ...opts.ctx.checkpointResult,
      _hardlinkAttempts: {
        ...(opts.ctx.checkpointResult?._hardlinkAttempts as Record<string, unknown>),
        [opts.operationIdentity]: {
          revisionId: opts.revisionId,
          coordinatorKey,
          phase,
          ...(result ? { result } : {}),
        },
      },
    });
  };
  // This records only the current caller's exact attempt, not a receiver lease
  // or containment proof. Unknown remote work is never submitted again.
  await checkpoint("attempted");
  signal?.throwIfAborted();
  try {
    const result = unwrapDataManagerResponse(
      await link({ plan, prune: true }, { transport, signal }),
    );
    const summary = { applied: true, entries: plan.length, via: url, ...result };
    await checkpoint("complete", summary);
    return summary;
  } catch (error) {
    if (error instanceof JobOwnershipLost) throw error;
    if (opts.ctx) throw new JobObservationPending("recovery_required");
    throw error;
  }
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
  await ctx.log(`Rendering compose for latest config...`);
  const { revisionId } = await renderAndPersistCompose({
    ctx,
    operationKey: createDurableOpsKey("admin-job.config.render", `${ctx.jobId}:${service}`),
    signal: ctx.signal,
  });
  const hardlinks = await applyGenerationHardlinks({
    ctx,
    revisionId,
    operationIdentity: `${ctx.jobId}:${service}`,
    log: (m) => ctx.log(m),
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
          ctx,
          kind: "vault.apply",
          serviceId: service,
          operationKey: createDurableOpsKey("admin-job.vault.apply", `${ctx.jobId}:${service}`),
          signal: ctx.signal,
        })
      : await renderAndPersistCompose({
          ctx,
          operationKey: createDurableOpsKey("admin-job.config.apply", `${ctx.jobId}:${service}`),
          signal: ctx.signal,
        });
  const hardlinks = await applyGenerationHardlinks({
    ctx,
    revisionId,
    operationIdentity: `${ctx.jobId}:${service}`,
    log: (m) => ctx.log(m),
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
