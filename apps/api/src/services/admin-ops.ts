import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { services as coreServices, repoPaths } from "@openmapx/core/server";
import { dockerComposeAction } from "../utils/docker-compose";
import type { JobContext } from "./job-runner";
import { resolveAllServiceConfigs } from "./service-config-resolver";
import { getServiceRegistry } from "./service-registry";

const execFile = promisify(execFileCb);
const { DataManagerClient, buildAppApiServiceEnv, renderCompose } = coreServices;

const HARDLINK_PLAN_FILE = "docker-compose.generated.hardlinks.json";
const DATA_MANAGER_STARTUP_TIMEOUT_MS = 60_000;
const DATA_MANAGER_POLL_INTERVAL_MS = 2_000;

interface HardlinkPlanEntry {
  source: string;
  target: string;
  consumerService: string;
  dataType: string;
  targetFilename?: string;
}

export interface HardlinkApplySummary {
  applied: boolean;
  linked: number;
  skipped: number;
  pruned: number;
  entries: number;
  via?: string;
}

// Path resolution

function findInfraDir(): string {
  if (process.env.DOCKER_INFRA_DIR) return process.env.DOCKER_INFRA_DIR;
  // Compute from this file: apps/api/src/services/ → ../../../../infra/docker
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "..", "..", "..", "..", "infra", "docker");
}

export const INFRA_DIR = findInfraDir();
export const DATA_DIR = join(INFRA_DIR, "data");

// Docker availability — checked solely via `docker info`. The generated compose
// file is rendered on demand by `pnpm openmapx compose render` and is not a
// prerequisite for the daemon itself being reachable.

let _dockerCache: boolean | null = null;
let _dockerCacheAt = 0;
const DOCKER_CACHE_TTL = 60_000; // 60 seconds

export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerCache !== null && Date.now() - _dockerCacheAt < DOCKER_CACHE_TTL) return _dockerCache;
  try {
    await execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
    _dockerCache = true;
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
 * Render docker-compose.generated.yml + hardlink plan from the current service
 * registry and operator config layers (defaults + DB + env). Called before
 * `service.start` so "save config + apply" can take effect without requiring
 * a separate manual CLI render.
 */
export async function renderAndPersistCompose(): Promise<void> {
  const registry = getServiceRegistry();
  const enabled = registry.enabled();
  const paths = repoPaths();
  const resolvedServiceConfigs = await resolveAllServiceConfigs(
    enabled.map((service) => ({
      id: service.manifest.id,
      configSchema: service.manifest.configSchema,
      containerEnv: service.manifest.container.environment,
    })),
  );

  if (enabled.some((service) => service.manifest.id === "app-api")) {
    resolvedServiceConfigs.set(
      "app-api",
      buildAppApiServiceEnv(enabled, resolvedServiceConfigs.get("app-api") ?? {}, process.env),
    );
  }

  const rendered = renderCompose(enabled, {
    domain: process.env.DOMAIN ?? "localhost",
    composeOutDir: paths.infraDir,
    allServices: registry.list(),
    resolvedServiceConfigs,
  });

  mkdirSync(paths.infraDir, { recursive: true });
  writeFileSync(paths.composeOutPath, rendered.composeYaml, "utf-8");
  writeFileSync(
    join(paths.infraDir, "docker-compose.generated.hardlinks.json"),
    JSON.stringify(rendered.hardlinkPlan, null, 2),
    "utf-8",
  );
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

async function waitForDataManagerClient(): Promise<{
  client: coreServices.DataManagerClient;
  url: string;
}> {
  const urls = dataManagerUrlCandidates();
  const deadline = Date.now() + DATA_MANAGER_STARTUP_TIMEOUT_MS;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    for (const url of urls) {
      const client = new DataManagerClient({ baseUrl: url });
      try {
        await client.status();
        return { client, url };
      } catch (err) {
        lastErr = err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, DATA_MANAGER_POLL_INTERVAL_MS));
  }

  const detail = (lastErr as Error | undefined)?.message ?? String(lastErr ?? "unknown error");
  throw new Error(
    `data-manager did not become reachable within ${DATA_MANAGER_STARTUP_TIMEOUT_MS / 1000}s (${urls.join(", ")}): ${detail}`,
  );
}

function readHardlinkPlanFromDisk(): HardlinkPlanEntry[] {
  const paths = repoPaths();
  const filePath = join(paths.infraDir, HARDLINK_PLAN_FILE);
  if (!existsSync(filePath)) {
    throw new Error(`Hardlink plan not found at ${filePath}. Render compose first.`);
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Hardlink plan at ${filePath} is not an array.`);
  }
  return parsed as HardlinkPlanEntry[];
}

/**
 * Ensure consumer data mounts are refreshed from producer directories before a
 * service/container start. Uses the data-manager `/link` endpoint because the
 * API container may not have direct host write access to infra/docker/data.
 */
export async function applyHardlinksFromPlan(
  opts: { log?: (msg: string) => Promise<void> | void } = {},
): Promise<HardlinkApplySummary> {
  const plan = readHardlinkPlanFromDisk();
  if (plan.length === 0) {
    return { applied: true, linked: 0, skipped: 0, pruned: 0, entries: 0 };
  }
  if (!dataManagerEnabled()) {
    throw new Error(
      `Hardlink plan contains ${plan.length} entr${plan.length === 1 ? "y" : "ies"}, but service "data-manager" is disabled. Enable data-manager before starting services from Admin, or apply links via CLI first.`,
    );
  }

  opts.log?.("Ensuring data-manager is running for hardlink apply...");
  const dmStart = await dockerComposeAction("data-manager", "start");
  if (dmStart.exitCode !== 0) {
    throw new Error(`docker compose up data-manager exited with ${dmStart.exitCode}`);
  }

  opts.log?.(`Applying hardlink plan (${plan.length} entries, prune enabled)...`);
  const { client, url } = await waitForDataManagerClient();
  const result = await client.link(plan, { prune: true });
  return { applied: true, entries: plan.length, via: url, ...result };
}

// Service control (job handlers) — registry-authorized + routed through the
// docker-compose helper that targets the generated compose file.

function assertKnownService(service: string): void {
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
}

export async function serviceStart(service: string, ctx: JobContext): Promise<void> {
  assertKnownService(service);
  await ctx.log(`Rendering compose for latest config...`);
  await renderAndPersistCompose();
  const hardlinks = await applyHardlinksFromPlan({ log: (m) => ctx.log(m) });
  if (hardlinks.applied) {
    await ctx.log(
      `Hardlinks applied (${hardlinks.linked} linked, ${hardlinks.skipped} already linked, ${hardlinks.pruned} pruned)`,
    );
  }
  await ctx.log(`Starting ${service}...`);
  const r = await dockerComposeAction(service, "start");
  if (r.exitCode !== 0) throw new Error(`docker compose up exited with ${r.exitCode}`);
  await ctx.log(`${service} started.`);
}

export async function serviceStop(service: string, ctx: JobContext): Promise<void> {
  assertKnownService(service);
  await ctx.log(`Stopping ${service}...`);
  const r = await dockerComposeAction(service, "stop");
  if (r.exitCode !== 0) throw new Error(`docker compose stop exited with ${r.exitCode}`);
  await ctx.log(`${service} stopped.`);
}

export async function serviceRestart(service: string, ctx: JobContext): Promise<void> {
  assertKnownService(service);
  await ctx.log(`Restarting ${service}...`);
  const r = await dockerComposeAction(service, "restart");
  if (r.exitCode !== 0) throw new Error(`docker compose restart exited with ${r.exitCode}`);
  await ctx.log(`${service} restarted.`);
}

// Data inventory — used by the admin "Data" workflow page to show which OSM
// PBF was downloaded and which heavy build artifacts (Valhalla tiles, OSRM
// graph, Nominatim database, etc.) are present on disk. Build creation itself
// has moved into the per-service `data-manager` flow + service startup; this
// surface is read-only.

export interface OsmPbfInfo {
  found: boolean;
  filename?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  region?: string;
}

export async function getOsmPbfInfo(): Promise<OsmPbfInfo> {
  const osmDir = join(DATA_DIR, "osm");
  const dir = existsSync(osmDir) ? osmDir : DATA_DIR;
  if (!existsSync(dir)) return { found: false };
  try {
    const files = await readdir(dir);
    const pbf = files.find((f) => f.endsWith(".osm.pbf"));
    if (!pbf) return { found: false };
    const stat = statSync(join(dir, pbf));
    return {
      found: true,
      filename: pbf,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      region: pbf.replace(/-latest\.osm\.pbf$/, "").replace(/\.osm\.pbf$/, ""),
    };
  } catch {
    return { found: false };
  }
}

export interface BuildStatus {
  target: string;
  built: boolean;
  builtAt?: string;
}

// Heuristic check — looks at well-known directories under `data/` and reports
// whether each appears to have been populated. The producer for each varies
// (services build themselves on first start, data-manager populates the OSM
// dir, etc.) so this is intentionally a directory-mtime probe, not an exact
// "has the build completed?" answer.
const BUILT_PRODUCT_DIRS: Record<string, string> = {
  valhalla: "valhalla",
  osrm: "osrm-graph",
  otp: "otp-graph",
  motis: "motis-data",
  motisFeedProxy: "motis-feed-proxy",
  tiles: "tile-mbtiles",
  pelias: "pelias",
  nominatim: "nominatim",
  photon: "photon",
  overpass: "overpass",
};

export async function getBuildStatuses(): Promise<BuildStatus[]> {
  return Promise.all(
    Object.entries(BUILT_PRODUCT_DIRS).map(([target, rel]) => {
      const p = join(DATA_DIR, rel);
      if (!existsSync(p)) return { target, built: false };
      try {
        const stat = statSync(p);
        return { target, built: true, builtAt: stat.mtime.toISOString() };
      } catch {
        return { target, built: false };
      }
    }),
  );
}

export interface MotisTransitousStatus {
  configFound: boolean;
  datasetCount: number;
  realtimeFeedCount: number;
  gbfsFeedCount: number;
  feedProxyUrlCount: number;
  feedProxyMode: "none" | "self-hosted" | "transitous-cloud" | "mixed";
  feedProxyConfigFound: boolean;
  feedProxyVarsFound: boolean;
  feedProxyFeedCount: number;
}

function countGbfsFeeds(configText: string): number {
  const lines = configText.split(/\r?\n/);
  let inGbfs = false;
  let inFeeds = false;
  let feedsIndent = 0;
  let count = 0;

  for (const line of lines) {
    const indent = (line.match(/^\s*/) ?? [""])[0].length;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!inGbfs && trimmed === "gbfs:") {
      inGbfs = true;
      inFeeds = false;
      continue;
    }

    if (inGbfs && !inFeeds && trimmed === "feeds:") {
      inFeeds = true;
      feedsIndent = indent;
      continue;
    }

    if (inGbfs && inFeeds) {
      if (indent <= feedsIndent) {
        inGbfs = false;
        inFeeds = false;
        continue;
      }
      if (/^[^#\s][^:]*:\s*$/.test(trimmed)) {
        count += 1;
      }
      continue;
    }

    if (inGbfs && indent === 0 && trimmed.endsWith(":") && trimmed !== "gbfs:") {
      inGbfs = false;
      inFeeds = false;
    }
  }

  return count;
}

export function getMotisTransitousStatus(): MotisTransitousStatus {
  const motisDir = join(DATA_DIR, "motis-data");
  const feedProxyDir = join(DATA_DIR, "motis-feed-proxy");
  const configPath = join(motisDir, "config.yml");
  const feedProxyConfigPath = join(feedProxyDir, "default.conf");
  const feedProxyVarsPath = join(feedProxyDir, "feed-proxy-vars.json");

  const feedProxyConfigFound = existsSync(feedProxyConfigPath);
  const feedProxyVarsFound = existsSync(feedProxyVarsPath);
  let feedProxyFeedCount = 0;
  if (feedProxyVarsFound) {
    try {
      const parsed = JSON.parse(readFileSync(feedProxyVarsPath, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        feedProxyFeedCount = Object.keys(parsed).length;
      }
    } catch {
      feedProxyFeedCount = 0;
    }
  }

  if (!existsSync(configPath)) {
    return {
      configFound: false,
      datasetCount: 0,
      realtimeFeedCount: 0,
      gbfsFeedCount: 0,
      feedProxyUrlCount: 0,
      feedProxyMode: "none",
      feedProxyConfigFound,
      feedProxyVarsFound,
      feedProxyFeedCount,
    };
  }

  const configText = readFileSync(configPath, "utf-8");
  const datasetCount = (configText.match(/^\s*path:\s+/gm) ?? []).length;
  const realtimeFeedCount = (configText.match(/^\s*protocol:\s+/gm) ?? []).length;
  const gbfsFeedCount = countGbfsFeeds(configText);

  const feedProxyHosts = Array.from(
    configText.matchAll(/url:\s*(https?:\/\/[^\s"']*\/feed\/[^\s"']*)/g),
  )
    .map((match) => {
      const raw = match[1];
      if (!raw) return null;
      try {
        return new URL(raw).hostname.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter((host): host is string => Boolean(host));

  const uniqueHosts = new Set(feedProxyHosts);
  const feedProxyUrlCount = feedProxyHosts.length;
  const hasTransitousProxy = uniqueHosts.has("rt.triptix.tech");
  const hasOtherProxy = [...uniqueHosts].some((host) => host !== "rt.triptix.tech");
  const feedProxyMode: MotisTransitousStatus["feedProxyMode"] =
    feedProxyUrlCount === 0
      ? "none"
      : hasTransitousProxy && hasOtherProxy
        ? "mixed"
        : hasTransitousProxy
          ? "transitous-cloud"
          : "self-hosted";

  return {
    configFound: true,
    datasetCount,
    realtimeFeedCount,
    gbfsFeedCount,
    feedProxyUrlCount,
    feedProxyMode,
    feedProxyConfigFound,
    feedProxyVarsFound,
    feedProxyFeedCount,
  };
}
