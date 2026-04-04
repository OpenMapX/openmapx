import { execFile as execFileCb, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { JobContext } from "./job-runner";

const execFile = promisify(execFileCb);

// ---- Path resolution ------------------------------------------------------

function findInfraDir(): string {
  if (process.env.DOCKER_INFRA_DIR) return process.env.DOCKER_INFRA_DIR;
  // Compute from this file: apps/api/src/services/ → ../../../../infra/docker
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "..", "..", "..", "..", "infra", "docker");
}

export const INFRA_DIR = findInfraDir();
export const COMPOSE_FILE = join(INFRA_DIR, "docker-compose.yml");
export const MANAGE_SH = join(INFRA_DIR, "manage.sh");
export const DATA_DIR = join(INFRA_DIR, "data");

// ---- Allowlists -----------------------------------------------------------

export const ALLOWED_SERVICES = new Set([
  "postgis",
  "redis",
  "traefik",
  "api",
  "web",
  "well-known",
  "valhalla",
  "osrm",
  "motis",
  "otp",
  "elasticsearch",
  "pelias-api",
  "pelias-placeholder",
  "pelias-pip",
  "nominatim",
  "photon",
  "overpass",
  "martin",
  "tileserver",
]);

export const ALLOWED_PROFILES = new Set([
  "proxy",
  "app",
  "routing",
  "transit",
  "pelias",
  "nominatim",
  "photon",
  "overpass",
  "tiles",
  "martin",
]);

export const ALLOWED_BUILD_TARGETS = new Set([
  "valhalla",
  "osrm",
  "otp",
  "motis",
  "tiles",
  "pelias",
  "nominatim",
  "photon",
  "overpass",
]);

export const PROFILE_SERVICES: Record<string, string[]> = {
  core: ["postgis", "redis"],
  proxy: ["traefik"],
  app: ["api", "web", "well-known"],
  routing: ["valhalla", "osrm"],
  transit: ["motis", "otp"],
  pelias: ["elasticsearch", "pelias-api", "pelias-placeholder", "pelias-pip"],
  nominatim: ["nominatim"],
  photon: ["photon"],
  overpass: ["overpass"],
  tiles: ["tileserver"],
  martin: ["martin"],
};

export const SERVICE_META: Record<string, { image: string; profile: string; port?: number }> = {
  postgis: { image: "postgis/postgis:18-3.6", profile: "core", port: 5432 },
  redis: { image: "valkey/valkey:8-alpine", profile: "core", port: 6379 },
  traefik: { image: "traefik:v3.6", profile: "proxy", port: 443 },
  api: { image: "ghcr.io/medformatik/openmapx-api:latest", profile: "app", port: 3001 },
  web: { image: "ghcr.io/medformatik/openmapx-web:latest", profile: "app", port: 3000 },
  "well-known": { image: "nginx:alpine", profile: "app" },
  valhalla: { image: "ghcr.io/valhalla/valhalla-scripted:latest", profile: "routing", port: 8002 },
  osrm: { image: "ghcr.io/project-osrm/osrm-backend:latest", profile: "routing", port: 5000 },
  motis: { image: "ghcr.io/motis-project/motis:latest", profile: "transit", port: 8081 },
  otp: { image: "opentripplanner/opentripplanner:latest", profile: "transit", port: 8090 },
  elasticsearch: { image: "elasticsearch:7.17.18", profile: "pelias", port: 9200 },
  "pelias-api": { image: "pelias/api:latest", profile: "pelias", port: 4000 },
  "pelias-placeholder": { image: "pelias/placeholder:latest", profile: "pelias", port: 4100 },
  "pelias-pip": { image: "pelias/pip-service:latest", profile: "pelias", port: 4200 },
  nominatim: { image: "mediagis/nominatim:5.2", profile: "nominatim", port: 8088 },
  photon: { image: "rtuszik/photon-docker:latest", profile: "photon", port: 2322 },
  overpass: { image: "wiktorn/overpass-api:latest", profile: "overpass", port: 8082 },
  martin: { image: "ghcr.io/maplibre/martin:latest", profile: "martin", port: 3002 },
  tileserver: { image: "maptiler/tileserver-gl:latest", profile: "tiles", port: 8080 },
};

// ---- Docker availability --------------------------------------------------

let _dockerCache: boolean | null = null;
let _dockerCacheAt = 0;
const DOCKER_CACHE_TTL = 60_000; // 60 seconds

export async function isDockerAvailable(): Promise<boolean> {
  if (_dockerCache !== null && Date.now() - _dockerCacheAt < DOCKER_CACHE_TTL) return _dockerCache;
  if (!existsSync(COMPOSE_FILE)) {
    _dockerCache = false;
    _dockerCacheAt = Date.now();
    return false;
  }
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

// ---- docker compose helpers -----------------------------------------------

function composeArgs(...extra: string[]): string[] {
  return ["compose", "-f", COMPOSE_FILE, ...extra];
}

// ---- Service status -------------------------------------------------------

export interface ServiceStatus {
  service: string;
  state: "running" | "stopped" | "unhealthy" | "unknown";
  status: string;
  image: string;
  id: string;
  ports: string;
  runningFor: string;
  health: string;
  profile: string;
  port?: number;
}

export async function getServiceStatuses(): Promise<ServiceStatus[]> {
  let raw = "";
  try {
    const { stdout } = await execFile("docker", composeArgs("ps", "--format", "json", "--all"), {
      timeout: 15_000,
    });
    raw = stdout;
  } catch {
    return buildOfflineStatuses();
  }

  const rows: ServiceStatus[] = [];
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as {
        Service: string;
        State: string;
        Status: string;
        Image: string;
        ID: string;
        Ports: string;
        RunningFor: string;
        Health: string;
      };
      const stateLC = (r.State ?? "").toLowerCase();
      let state: ServiceStatus["state"] = "unknown";
      if (stateLC === "running") {
        state = r.Health === "unhealthy" ? "unhealthy" : "running";
      } else if (
        stateLC === "exited" ||
        stateLC === "created" ||
        stateLC === "dead" ||
        stateLC === ""
      ) {
        state = "stopped";
      }
      const meta = SERVICE_META[r.Service];
      rows.push({
        service: r.Service,
        state,
        status: r.Status ?? "",
        image: r.Image ?? meta?.image ?? "",
        id: (r.ID ?? "").slice(0, 12),
        ports: r.Ports ?? "",
        runningFor: r.RunningFor ?? "",
        health: r.Health ?? "",
        profile: meta?.profile ?? "core",
        port: meta?.port,
      });
    } catch {
      // skip malformed line
    }
  }

  // Include services not returned by ps (stopped and never started)
  const seen = new Set(rows.map((r) => r.service));
  for (const [svc, meta] of Object.entries(SERVICE_META)) {
    if (!seen.has(svc)) {
      rows.push({
        service: svc,
        state: "stopped",
        status: "Not created",
        image: meta.image,
        id: "",
        ports: meta.port ? `127.0.0.1:${meta.port}` : "",
        runningFor: "",
        health: "",
        profile: meta.profile,
        port: meta.port,
      });
    }
  }

  return rows;
}

function buildOfflineStatuses(): ServiceStatus[] {
  return Object.entries(SERVICE_META).map(([svc, meta]) => ({
    service: svc,
    state: "unknown" as const,
    status: "Docker unavailable",
    image: meta.image,
    id: "",
    ports: meta.port ? `127.0.0.1:${meta.port}` : "",
    runningFor: "",
    health: "",
    profile: meta.profile,
    port: meta.port,
  }));
}

// ---- Logs -----------------------------------------------------------------

export async function getServiceLogs(service: string, lines = 100): Promise<string> {
  if (!ALLOWED_SERVICES.has(service)) throw new Error(`"${service}" is not an allowed service`);
  const { stdout, stderr } = await execFile(
    "docker",
    composeArgs("logs", "--no-log-prefix", `--tail=${lines}`, "--timestamps", service),
    { timeout: 30_000 },
  );
  return (stdout + stderr).trim();
}

// ---- Service control (creates jobs — these are the job handlers) ----------

export async function serviceStart(service: string, ctx: JobContext): Promise<void> {
  if (!ALLOWED_SERVICES.has(service)) throw new Error(`"${service}" is not an allowed service`);
  await ctx.log(`Starting ${service}...`);
  await execFile("docker", composeArgs("up", "-d", "--no-deps", service), { timeout: 120_000 });
  await ctx.log(`${service} started.`);
}

export async function serviceStop(service: string, ctx: JobContext): Promise<void> {
  if (!ALLOWED_SERVICES.has(service)) throw new Error(`"${service}" is not an allowed service`);
  await ctx.log(`Stopping ${service}...`);
  await execFile("docker", composeArgs("stop", service), { timeout: 60_000 });
  await ctx.log(`${service} stopped.`);
}

export async function serviceRestart(service: string, ctx: JobContext): Promise<void> {
  if (!ALLOWED_SERVICES.has(service)) throw new Error(`"${service}" is not an allowed service`);
  await ctx.log(`Restarting ${service}...`);
  await execFile("docker", composeArgs("restart", service), { timeout: 120_000 });
  await ctx.log(`${service} restarted.`);
}

export async function profileStart(profile: string, ctx: JobContext): Promise<void> {
  if (!ALLOWED_PROFILES.has(profile)) throw new Error(`"${profile}" is not an allowed profile`);
  const services = PROFILE_SERVICES[profile] ?? [];
  await ctx.log(`Starting profile "${profile}" (${services.join(", ")})...`);
  await execFile(
    "docker",
    composeArgs("--profile", profile, "up", "-d", "--no-deps", ...services),
    { timeout: 120_000 },
  );
  await ctx.log(`Profile "${profile}" started.`);
}

export async function profileStop(profile: string, ctx: JobContext): Promise<void> {
  if (!ALLOWED_PROFILES.has(profile)) throw new Error(`"${profile}" is not an allowed profile`);
  const services = PROFILE_SERVICES[profile] ?? [];
  await ctx.log(`Stopping profile "${profile}" (${services.join(", ")})...`);
  await execFile("docker", composeArgs("stop", ...services), { timeout: 60_000 });
  await ctx.log(`Profile "${profile}" stopped.`);
}

// ---- Safe env for child processes -----------------------------------------

/** Allowlist of env vars passed to child processes (manage.sh, integration.sh). */
const CHILD_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "COMPOSE_PROJECT_NAME",
  "COMPOSE_FILE",
  "DOCKER_INFRA_DIR",
  "NODE_ENV",
]);

export function safeChildEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val) env[key] = val;
  }
  return env as NodeJS.ProcessEnv;
}

// ---- Build (streaming via manage.sh) --------------------------------------

export async function buildTarget(target: string, ctx: JobContext): Promise<void> {
  if (!ALLOWED_BUILD_TARGETS.has(target))
    throw new Error(`"${target}" is not an allowed build target`);
  if (!existsSync(MANAGE_SH)) throw new Error(`manage.sh not found at: ${MANAGE_SH}`);

  await ctx.log(`Starting build: ${target}...`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("/bin/bash", [MANAGE_SH, "build", target], {
      env: safeChildEnv(),
    });

    ctx.signal.addEventListener("abort", () => {
      child.kill("SIGTERM");
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        void ctx.log(line, "stdout");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        void ctx.log(line, "stderr");
      }
    });

    child.on("close", (code) => {
      if (code === 0 || ctx.signal.aborted) resolve();
      else reject(new Error(`Build exited with code ${code}`));
    });

    child.on("error", reject);
  });
}

// ---- Data inventory -------------------------------------------------------

export interface OsmPbfInfo {
  found: boolean;
  filename?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  region?: string;
}

export async function getOsmPbfInfo(): Promise<OsmPbfInfo> {
  if (!existsSync(DATA_DIR)) return { found: false };
  try {
    const files = await readdir(DATA_DIR);
    const pbf = files.find((f) => f.endsWith(".osm.pbf"));
    if (!pbf) return { found: false };
    const stat = statSync(join(DATA_DIR, pbf));
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

const BUILD_CHECK_PATHS: Record<string, string> = {
  valhalla: "valhalla",
  osrm: "osrm",
  otp: "otp",
  motis: "motis",
  tiles: "tiles",
  pelias: "pelias-elasticsearch",
  nominatim: "nominatim",
  photon: "photon",
  overpass: "overpass",
};

export async function getBuildStatuses(): Promise<BuildStatus[]> {
  return Promise.all(
    Array.from(ALLOWED_BUILD_TARGETS).map((target) => {
      const rel = BUILD_CHECK_PATHS[target];
      if (!rel) return { target, built: false };
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
