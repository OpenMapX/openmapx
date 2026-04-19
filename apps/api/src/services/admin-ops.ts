import { execFile as execFileCb } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dockerComposeAction } from "../utils/docker-compose";
import type { JobContext } from "./job-runner";
import { getServiceRegistry } from "./service-registry";

const execFile = promisify(execFileCb);

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
  osrm: "osrm",
  otp: "otp",
  motis: "motis",
  tiles: "tileserver",
  pelias: "pelias-elasticsearch",
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
