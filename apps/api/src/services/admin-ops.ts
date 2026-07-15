import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { services as coreServices, repoPaths } from "@openmapx/core/server";
import { parseMotisConfigExpectations } from "@openmapx/transitous-core";
import { dockerComposeAction } from "../utils/docker-compose";
import { envString } from "../utils/env";
import type { JobContext } from "./job-runner";
import { resolveAllServiceConfigs } from "./service-config-resolver";
import { getServiceRegistry } from "./service-registry";
import { regenerateServiceSecretFiles } from "./service-secret-files";
import { resolveServiceVaultSecrets } from "./service-secrets";

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
//
// Order of preference (matches the rest of apps/api):
//   1. `DOCKER_INFRA_DIR` — explicit override.
//   2. `OPENMAPX_ROOT_DIR` (resolved by `repoPaths()`) — set by the rendered
//      compose to the host repo path that is bind-mounted at the same
//      absolute path inside the container, so `<root>/infra/docker/data`
//      always points at the real data dir.
//   3. Walk up from this file's location — only useful in dev (`pnpm dev`),
//      because esbuild's bundled `apps/api/dist/server.js` collapses the
//      directory layout and a `../../../..` walk lands on `/app`.

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

  // Resolve each enabled service's decrypted vault secrets. The key names wire
  // the rendered `secrets:` mounts; the values are written to the regenerated
  // secret files below. Both come from the same resolved set in one pass, so
  // the YAML and the on-disk files never drift.
  const secretsBySvc = new Map<string, Record<string, string>>();
  for (const service of enabled) {
    const secrets = await resolveServiceVaultSecrets(service.manifest.id);
    if (Object.keys(secrets).length > 0) secretsBySvc.set(service.manifest.id, secrets);
  }
  const serviceSecretKeys = new Map(
    [...secretsBySvc].map(([id, secrets]) => [id, Object.keys(secrets)]),
  );

  const rendered = renderCompose(enabled, {
    domain: envString("DOMAIN", "localhost"),
    composeOutDir: paths.infraDir,
    allServices: registry.list(),
    resolvedServiceConfigs,
    serviceSecretKeys,
  });

  mkdirSync(paths.infraDir, { recursive: true });
  writeFileSync(paths.composeOutPath, rendered.composeYaml, "utf-8");
  writeFileSync(
    join(paths.infraDir, "docker-compose.generated.hardlinks.json"),
    JSON.stringify(rendered.hardlinkPlan, null, 2),
    "utf-8",
  );
  // Always (re)generate — even when empty — so removing the last credential
  // wipes the directory.
  regenerateServiceSecretFiles(paths.infraDir, secretsBySvc);
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

export async function serviceRecreate(service: string, ctx: JobContext): Promise<void> {
  assertKnownService(service);
  await ctx.log(`Rendering compose for latest config + secrets...`);
  await renderAndPersistCompose();
  const hardlinks = await applyHardlinksFromPlan({ log: (m) => ctx.log(m) });
  if (hardlinks.applied) {
    await ctx.log(
      `Hardlinks applied (${hardlinks.linked} linked, ${hardlinks.skipped} already linked, ${hardlinks.pruned} pruned)`,
    );
  }
  await ctx.log(`Recreating ${service}...`);
  const r = await dockerComposeAction(service, "recreate");
  if (r.exitCode !== 0)
    throw new Error(`docker compose up --force-recreate exited with ${r.exitCode}`);
  await ctx.log(`${service} recreated.`);
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
  motis: "motis/live",
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

// Lightweight directory listing of the GTFS archives MOTIS reads at startup.
// Files appear here once `pnpm openmapx data download gtfs ...` (or the
// data-manager Transitous pipeline directly) has dropped them in /data/gtfs/.
// Distinct from the Postgres-imported feeds tracked by gtfsManager — the
// admin UI surfaces both lists together so an operator can see at a glance
// which feeds live in MOTIS, in Postgres, or in both.

export interface MotisGtfsArchive {
  /** Filename minus `.gtfs.zip` / `.netex.zip`. Stable id for matching against Postgres slugs. */
  id: string;
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
  format: "gtfs" | "netex";
  /** Upstream HTTP URL the archive was fetched from, looked up in the Transitous catalog. */
  originUrl?: string;
}

const GTFS_ARCHIVE_RE = /^([^.][^/]*?)\.(gtfs|netex)\.zip$/i;

interface TransitousCatalogSource {
  name?: string;
  type?: string;
  url?: string;
  spec?: string;
}

interface TransitousCatalogFile {
  sources?: TransitousCatalogSource[];
}

// `de_DELFI` -> upstream HTTP url. Matches the archive id format produced by
// the Transitous pipeline (`<region>_<source-name>`); we lowercase keys so a
// case-mismatched archive on disk still resolves.
function buildTransitousOriginIndex(): Map<string, string> {
  const index = new Map<string, string>();
  const feedsDir = join(DATA_DIR, ".transitous-catalog", "feeds");
  if (!existsSync(feedsDir)) return index;
  let entries: string[];
  try {
    entries = readdirSync(feedsDir);
  } catch {
    return index;
  }
  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const region = file
      .replace(/\.json$/, "")
      .split("-")[0]
      ?.toLowerCase();
    if (!region) continue;
    let data: TransitousCatalogFile;
    try {
      data = JSON.parse(readFileSync(join(feedsDir, file), "utf-8")) as TransitousCatalogFile;
    } catch {
      continue;
    }
    for (const source of data.sources ?? []) {
      if (source.type && source.type !== "http" && source.type !== "transitland-atlas") continue;
      // Skip GTFS-RT / GBFS / NeTEx — only the static GTFS schedule zip is what
      // ends up in /data/gtfs/ as `<region>_<name>.gtfs.zip`. Many feeds list
      // both the schedule and a realtime feed under the same `name`, and a
      // last-write-wins index would otherwise map the archive to the RT URL.
      const spec = (source.spec ?? "gtfs").toLowerCase();
      if (spec !== "gtfs") continue;
      if (!source.name || !source.url) continue;
      const archiveId = `${region}_${source.name}`.toLowerCase();
      index.set(archiveId, source.url);
    }
  }
  return index;
}

export async function getMotisGtfsArchives(): Promise<MotisGtfsArchive[]> {
  const gtfsDir = join(DATA_DIR, "gtfs");
  if (!existsSync(gtfsDir)) return [];
  const originIndex = buildTransitousOriginIndex();
  try {
    const entries = await readdir(gtfsDir);
    const archives: MotisGtfsArchive[] = [];
    for (const name of entries) {
      const match = GTFS_ARCHIVE_RE.exec(name);
      if (!match) continue;
      const id = match[1];
      const format = match[2].toLowerCase() as "gtfs" | "netex";
      if (!id) continue;
      try {
        const stat = statSync(join(gtfsDir, name));
        archives.push({
          id,
          filename: name,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          format,
          originUrl: originIndex.get(id.toLowerCase()),
        });
      } catch {
        // Skip a missing/unreadable entry rather than failing the whole list.
      }
    }
    archives.sort((a, b) => a.id.localeCompare(b.id));
    return archives;
  } catch {
    return [];
  }
}

export interface MotisTransitousStatus {
  configFound: boolean;
  datasetCount: number;
  realtimeFeedCount: number;
  gbfsFeedCount: number;
  feedProxyUrlCount: number;
  gbfsProxyUrl: string | null;
  feedProxyMode: "none" | "self-hosted" | "transitous-cloud" | "mixed";
  feedProxyConfigFound: boolean;
  feedProxyVarsFound: boolean;
  feedProxyFeedCount: number;
  capabilityState: "healthy" | "stale" | "missing" | "error";
  capabilityError?: string;
  activeEpoch: string | null;
  candidateEpoch: string | null;
  testedAt: string | null;
  configHash: string | null;
  licenseHash: string | null;
  rentalProviderCount: number;
  rentalProviderGroupCount: number;
  rollbackAvailable: boolean;
}

interface MobilityCapabilitySnapshot {
  schemaVersion: 1;
  testedAt: string;
  epoch: string;
  artifacts: { config: { sha256: string }; license: { sha256: string } };
  rentals?: { providerIds?: string[]; providerGroupIds?: string[] };
}

function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readEpoch(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as { epoch?: unknown };
    return typeof value.epoch === "string" ? value.epoch : null;
  } catch {
    return null;
  }
}

export function getMotisTransitousStatus(): MotisTransitousStatus {
  const motisDir = join(DATA_DIR, "motis", "live");
  const feedProxyDir = join(DATA_DIR, "motis-feed-proxy");
  const configPath = join(motisDir, "config.yml");
  const feedProxyConfigPath = join(feedProxyDir, "conf", "default.conf");
  const feedProxyVarsPath = join(feedProxyDir, "feed-proxy-vars.json");
  const snapshotPath = join(motisDir, "mobility-capabilities.json");
  const candidateEpoch = readEpoch(
    join(DATA_DIR, "motis", "staging", "motis-candidate-manifest.json"),
  );
  const rollbackAvailable = existsSync(`${motisDir}.previous`);

  let snapshot: MobilityCapabilitySnapshot | null = null;
  let capabilityError: string | undefined;
  if (existsSync(snapshotPath)) {
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, "utf-8")) as MobilityCapabilitySnapshot;
      if (parsed.schemaVersion !== 1 || typeof parsed.epoch !== "string") {
        throw new Error("unsupported capability snapshot schema");
      }
      snapshot = parsed;
    } catch (error) {
      capabilityError = (error as Error).message;
    }
  }

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
      gbfsProxyUrl: null,
      feedProxyMode: "none",
      feedProxyConfigFound,
      feedProxyVarsFound,
      feedProxyFeedCount,
      capabilityState: capabilityError ? "error" : "missing",
      capabilityError,
      activeEpoch: snapshot?.epoch ?? null,
      candidateEpoch,
      testedAt: snapshot?.testedAt ?? null,
      configHash: null,
      licenseHash: hashFile(join(motisDir, "license.json")),
      rentalProviderCount: snapshot?.rentals?.providerIds?.length ?? 0,
      rentalProviderGroupCount: snapshot?.rentals?.providerGroupIds?.length ?? 0,
      rollbackAvailable,
    };
  }

  const configText = readFileSync(configPath, "utf-8");
  let expectations: ReturnType<typeof parseMotisConfigExpectations>;
  try {
    expectations = parseMotisConfigExpectations(configText);
  } catch (error) {
    expectations = {
      timetableDatasets: 0,
      realtimeFeeds: 0,
      gbfsFeeds: 0,
      expectsGbfs: false,
      tilesEnabled: false,
      elevationEnabled: false,
      routedTransfersEnabled: false,
      gbfsProxyUrl: null,
      feedProxyUrls: [],
    };
    capabilityError ??= `invalid MOTIS config: ${(error as Error).message}`;
  }
  const datasetCount = expectations.timetableDatasets;
  const realtimeFeedCount = expectations.realtimeFeeds;
  const gbfsFeedCount = expectations.gbfsFeeds;

  const feedProxyHosts = expectations.feedProxyUrls
    .map((raw) => {
      try {
        return new URL(raw).hostname.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter((host): host is string => Boolean(host));

  const uniqueHosts = new Set(feedProxyHosts);
  const gbfsProxyUrl = expectations.gbfsProxyUrl;
  if (gbfsProxyUrl) {
    try {
      uniqueHosts.add(new URL(gbfsProxyUrl).hostname.toLowerCase());
    } catch {
      // Invalid operator YAML remains visible via gbfsProxyUrl; it is not
      // classified as a healthy self-hosted endpoint.
    }
  }
  const feedProxyUrlCount = feedProxyHosts.length;
  const hasTransitousProxy = uniqueHosts.has("rt.triptix.tech");
  const hasOtherProxy = [...uniqueHosts].some((host) => host !== "rt.triptix.tech");
  const feedProxyMode: MotisTransitousStatus["feedProxyMode"] =
    uniqueHosts.size === 0
      ? "none"
      : hasTransitousProxy && hasOtherProxy
        ? "mixed"
        : hasTransitousProxy
          ? "transitous-cloud"
          : "self-hosted";
  const configHash = hashFile(configPath);
  const licenseHash = hashFile(join(motisDir, "license.json"));
  const capabilityState: MotisTransitousStatus["capabilityState"] = capabilityError
    ? "error"
    : !snapshot
      ? "missing"
      : snapshot.artifacts.config.sha256 !== configHash ||
          snapshot.artifacts.license.sha256 !== licenseHash
        ? "stale"
        : "healthy";

  return {
    configFound: true,
    datasetCount,
    realtimeFeedCount,
    gbfsFeedCount,
    feedProxyUrlCount,
    gbfsProxyUrl,
    feedProxyMode,
    feedProxyConfigFound,
    feedProxyVarsFound,
    feedProxyFeedCount,
    capabilityState,
    capabilityError,
    activeEpoch: snapshot?.epoch ?? null,
    candidateEpoch,
    testedAt: snapshot?.testedAt ?? null,
    configHash,
    licenseHash,
    rentalProviderCount: snapshot?.rentals?.providerIds?.length ?? 0,
    rentalProviderGroupCount: snapshot?.rentals?.providerGroupIds?.length ?? 0,
    rollbackAvailable,
  };
}
