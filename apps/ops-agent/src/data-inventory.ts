import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { OpsResultFor } from "@openmapx/core/ops";
import {
  listDescriptorAnchoredDirectory,
  readDescriptorAnchoredUtf8,
  statDescriptorAnchoredEntry,
} from "./descriptor-file";

const MAX_STATUS_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1024;
const MAX_GBFS_SOURCES = 500;
const MAX_TEXT = 2_048;

type DataInventory = OpsResultFor<"data.inspect">;
type MotisInventory = DataInventory["motisTransitous"];

const BUILT_PRODUCT_DIRS = {
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
} as const;

interface MobilityCapabilitySnapshot {
  schemaVersion: 1;
  testedAt: string;
  epoch: string;
  artifacts: { config: { sha256: string }; license: { sha256: string } };
  rentals?: { providerIds?: string[]; providerGroupIds?: string[] };
}

interface MotisConfigExpectations {
  timetableDatasets: number;
  realtimeFeeds: number;
  gbfsFeeds: number;
  expectsGbfs: boolean;
  tilesEnabled: boolean;
  elevationEnabled: boolean;
  routedTransfersEnabled: boolean;
  gbfsProxyUrl: string | null;
  feedProxyUrls: string[];
}

async function parseMotisConfig(configText: string): Promise<MotisConfigExpectations> {
  const moduleUrl = new URL(
    "../../../packages/transitous-core/src/motis-config.ts",
    import.meta.url,
  ).href;
  const module = (await import(moduleUrl)) as {
    parseMotisConfigExpectations(value: string): MotisConfigExpectations;
  };
  return module.parseMotisConfigExpectations(configText);
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : null;
}

function safeLstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  const stat = safeLstat(path);
  return stat?.isDirectory() === true && stat.isSymbolicLink() === false;
}

function readBoundedUtf8(rootDir: string, path: string): string | null {
  try {
    const child = relative(rootDir, path);
    if (!child || child.startsWith(`..${sep}`) || child === "..") return null;
    return readDescriptorAnchoredUtf8(rootDir, child.split(sep), {
      maximumBytes: MAX_STATUS_FILE_BYTES,
    });
  } catch {
    return null;
  }
}

function readJsonObject(rootDir: string, path: string): Record<string, unknown> | null {
  const text = readBoundedUtf8(rootDir, path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readEpoch(rootDir: string, path: string): string | null {
  const value = boundedString(readJsonObject(rootDir, path)?.epoch);
  return value && value.length > 0 ? value : null;
}

function hashFile(rootDir: string, path: string): string | null {
  const value = readBoundedUtf8(rootDir, path);
  return value === null ? null : createHash("sha256").update(value).digest("hex");
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function countBoundedStrings(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.slice(0, MAX_DIRECTORY_ENTRIES).filter((item) => boundedString(item) !== null)
    .length;
}

function inspectOsm(dataRoot: string): DataInventory["osm"] {
  const osmDir = join(dataRoot, "osm");
  const directory = isDirectory(osmDir) ? osmDir : dataRoot;
  if (!isDirectory(directory)) return { found: false };
  let entries: ReturnType<typeof listDescriptorAnchoredDirectory>;
  try {
    const child = relative(dataRoot, directory);
    entries = listDescriptorAnchoredDirectory(dataRoot, child ? child.split(sep) : [], {
      maximumEntries: MAX_DIRECTORY_ENTRIES,
    });
  } catch {
    return { found: false };
  }
  const name = entries
    .filter(
      (entry) =>
        entry.type === "file" && entry.name.length <= 255 && entry.name.endsWith(".osm.pbf"),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))[0];
  if (!name) return { found: false };
  // Read the metadata through the same descriptor-anchored walk that chose the
  // name. Reopening `join(directory, name)` would let a rename between
  // enumeration and stat fabricate the reported size and timestamp.
  const child = relative(dataRoot, directory);
  let metadata: ReturnType<typeof statDescriptorAnchoredEntry>;
  try {
    metadata = statDescriptorAnchoredEntry(dataRoot, [...(child ? child.split(sep) : []), name]);
  } catch {
    return { found: false };
  }
  if (metadata.type !== "file") return { found: false };
  return {
    found: true,
    filename: name,
    sizeBytes: metadata.sizeBytes,
    modifiedAt: new Date(metadata.modifiedAtMs).toISOString(),
    region: name
      .replace(/-latest\.osm\.pbf$/, "")
      .replace(/\.osm\.pbf$/, "")
      .slice(0, MAX_TEXT),
  };
}

function inspectBuilds(dataRoot: string): DataInventory["builds"] {
  return Object.entries(BUILT_PRODUCT_DIRS).map(([target, relativePath]) => {
    const key = target as keyof typeof BUILT_PRODUCT_DIRS;
    try {
      // Descriptor-anchored so that a renamed or hardlinked path cannot
      // fabricate a built status or timestamp.
      const metadata = statDescriptorAnchoredEntry(dataRoot, relativePath.split("/"));
      return metadata.type === "directory"
        ? { target: key, built: true, builtAt: new Date(metadata.modifiedAtMs).toISOString() }
        : { target: key, built: false };
    } catch {
      return { target: key, built: false };
    }
  });
}

function missingGbfsCatalog(): MotisInventory["gbfsCatalog"] {
  return {
    state: "missing",
    commit: null,
    lockedAt: null,
    registryRows: 0,
    registryAdded: 0,
    transitousPreferred: 0,
    quarantined: 0,
    validationFailed: 0,
    sources: [],
  };
}

function inspectGbfsCatalog(rootDir: string, motisDir: string): MotisInventory["gbfsCatalog"] {
  const parsed = readJsonObject(rootDir, join(motisDir, "gbfs-source-index.json"));
  if (!parsed) return missingGbfsCatalog();
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sources)) {
    return { ...missingGbfsCatalog(), state: "error" };
  }
  if (parsed.sources.length > MAX_GBFS_SOURCES) {
    return { ...missingGbfsCatalog(), state: "error" };
  }
  const validations = Array.isArray(parsed.validations) ? parsed.validations : [];
  const validated = new Set<string>();
  for (const item of validations.slice(0, MAX_GBFS_SOURCES)) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const entry = item as Record<string, unknown>;
      const sourceId = boundedString(entry.sourceId);
      if (sourceId && entry.ok === true) validated.add(sourceId);
    }
  }
  const sources: MotisInventory["gbfsCatalog"]["sources"] = [];
  for (const item of parsed.sources) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (entry.status !== "included" && entry.exclusionReason !== "validation") continue;
    const observation =
      entry.observation &&
      typeof entry.observation === "object" &&
      !Array.isArray(entry.observation)
        ? (entry.observation as Record<string, unknown>)
        : {};
    const sourceId = boundedString(entry.sourceId) ?? "unknown";
    const errorClass =
      boundedString(observation.lastErrorClass) ??
      boundedString(entry.exclusionReason) ??
      undefined;
    const lastObservedSuccess = boundedString(observation.lastObservedSuccess) ?? undefined;
    const lastErrorAt = boundedString(observation.lastErrorAt) ?? undefined;
    sources.push({
      sourceId,
      country: boundedString(entry.country) ?? "unknown",
      status: entry.status === "included" ? "configured" : "excluded",
      observation:
        observation.state === "validated" || validated.has(sourceId) ? "validated" : "unknown",
      ...(errorClass ? { errorClass } : {}),
      ...(lastObservedSuccess ? { lastObservedSuccess } : {}),
      ...(lastErrorAt ? { lastErrorAt } : {}),
      dataAge: "unknown",
    });
  }
  const summary =
    parsed.summary && typeof parsed.summary === "object" && !Array.isArray(parsed.summary)
      ? (parsed.summary as Record<string, unknown>)
      : {};
  const lock =
    parsed.lock && typeof parsed.lock === "object" && !Array.isArray(parsed.lock)
      ? (parsed.lock as Record<string, unknown>)
      : {};
  return {
    state: "active",
    commit: boundedString(lock.commit),
    lockedAt: boundedString(lock.lockedAt),
    registryRows: nonnegativeInteger(summary.registryRows),
    registryAdded: nonnegativeInteger(summary.healthy),
    transitousPreferred: nonnegativeInteger(summary.duplicate),
    quarantined: nonnegativeInteger(summary.quarantined),
    validationFailed: nonnegativeInteger(summary.failed),
    sources,
  };
}

function inspectCapability(rootDir: string, path: string): MobilityCapabilitySnapshot | null {
  const parsed = readJsonObject(rootDir, path);
  if (parsed?.schemaVersion !== 1) return null;
  const epoch = boundedString(parsed.epoch);
  const testedAt = boundedString(parsed.testedAt);
  const artifacts = parsed.artifacts;
  if (
    !epoch ||
    !testedAt ||
    !artifacts ||
    typeof artifacts !== "object" ||
    Array.isArray(artifacts)
  ) {
    return null;
  }
  const artifactObject = artifacts as Record<string, unknown>;
  const config = artifactObject.config;
  const license = artifactObject.license;
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !license ||
    typeof license !== "object" ||
    Array.isArray(license)
  ) {
    return null;
  }
  const configHash = boundedString((config as Record<string, unknown>).sha256);
  const licenseHash = boundedString((license as Record<string, unknown>).sha256);
  if (!configHash || !licenseHash) return null;
  const rentals =
    parsed.rentals && typeof parsed.rentals === "object" && !Array.isArray(parsed.rentals)
      ? (parsed.rentals as Record<string, unknown>)
      : undefined;
  return {
    schemaVersion: 1,
    epoch,
    testedAt,
    artifacts: { config: { sha256: configHash }, license: { sha256: licenseHash } },
    ...(rentals
      ? {
          rentals: {
            providerIds: Array.isArray(rentals.providerIds)
              ? rentals.providerIds
                  .slice(0, MAX_DIRECTORY_ENTRIES)
                  .filter((item): item is string => boundedString(item) !== null)
              : [],
            providerGroupIds: Array.isArray(rentals.providerGroupIds)
              ? rentals.providerGroupIds
                  .slice(0, MAX_DIRECTORY_ENTRIES)
                  .filter((item): item is string => boundedString(item) !== null)
              : [],
          },
        }
      : {}),
  };
}

async function inspectMotis(
  rootDir: string,
  infraDir: string,
  dataRoot: string,
): Promise<MotisInventory> {
  const motisDir = join(dataRoot, "motis", "live");
  const feedProxyDir = join(dataRoot, "motis-feed-proxy");
  const configPath = join(motisDir, "config.yml");
  const licensePath = join(motisDir, "license.json");
  const configText = readBoundedUtf8(rootDir, configPath);
  const feedProxyConfigFound =
    readBoundedUtf8(rootDir, join(feedProxyDir, "conf", "default.conf")) !== null;
  const feedProxyVars = readJsonObject(rootDir, join(feedProxyDir, "feed-proxy-vars.json"));
  const snapshotPath = join(motisDir, "mobility-capabilities.json");
  const snapshotText = readBoundedUtf8(rootDir, snapshotPath);
  const snapshot = inspectCapability(rootDir, snapshotPath);
  const capabilityError =
    snapshotText !== null && !snapshot ? "invalid capability snapshot" : undefined;
  const candidateEpoch = readEpoch(
    rootDir,
    join(dataRoot, "motis", "staging", "motis-candidate-manifest.json"),
  );
  const slotState = readJsonObject(rootDir, join(dataRoot, "motis", "slot-state.json"));
  const activeManifest = readJsonObject(rootDir, join(motisDir, "motis-candidate-manifest.json"));
  const preflight = readJsonObject(rootDir, join(dataRoot, "motis", "preflight.json"));
  const operationsPolicy =
    activeManifest?.operationsPolicy &&
    typeof activeManifest.operationsPolicy === "object" &&
    !Array.isArray(activeManifest.operationsPolicy)
      ? (activeManifest.operationsPolicy as Record<string, unknown>)
      : {};
  const profile = operationsPolicy.profile;
  const operationsProfile: MotisInventory["operationsProfile"] =
    profile === "regional-assisted" || profile === "regional-sovereign" || profile === "planet"
      ? profile
      : "unknown";
  const activeSlot: MotisInventory["activeSlot"] =
    slotState?.activeSlot === "A" || slotState?.activeSlot === "B" ? slotState.activeSlot : null;
  const previousHealthySlot: MotisInventory["previousHealthySlot"] =
    slotState?.previousHealthySlot === "A" || slotState?.previousHealthySlot === "B"
      ? slotState.previousHealthySlot
      : null;
  const estimate =
    preflight?.estimate &&
    typeof preflight.estimate === "object" &&
    !Array.isArray(preflight.estimate)
      ? (preflight.estimate as Record<string, unknown>)
      : {};
  const capacity =
    preflight?.capacity &&
    typeof preflight.capacity === "object" &&
    !Array.isArray(preflight.capacity)
      ? (preflight.capacity as Record<string, unknown>)
      : {};
  const base = {
    feedProxyConfigFound,
    feedProxyVarsFound: feedProxyVars !== null,
    feedProxyFeedCount: feedProxyVars
      ? Math.min(Object.keys(feedProxyVars).length, MAX_DIRECTORY_ENTRIES)
      : 0,
    activeEpoch: snapshot?.epoch ?? null,
    candidateEpoch,
    testedAt: snapshot?.testedAt ?? null,
    licenseHash: hashFile(rootDir, licensePath),
    rentalProviderCount: countBoundedStrings(snapshot?.rentals?.providerIds),
    rentalProviderGroupCount: countBoundedStrings(snapshot?.rentals?.providerGroupIds),
    rollbackAvailable:
      previousHealthySlot !== null || isDirectory(join(dataRoot, "motis", "live.previous")),
    operationsProfile,
    activeSlot,
    previousHealthySlot,
    preflightState: preflight
      ? preflight.ok === true
        ? ("passed" as const)
        : ("blocked" as const)
      : ("missing" as const),
    preflightRequiredDiskBytes:
      typeof estimate.requiredDiskBytes === "number" &&
      Number.isSafeInteger(estimate.requiredDiskBytes) &&
      estimate.requiredDiskBytes >= 0
        ? estimate.requiredDiskBytes
        : null,
    preflightFreeDiskBytes:
      typeof capacity.freeDiskBytes === "number" &&
      Number.isSafeInteger(capacity.freeDiskBytes) &&
      capacity.freeDiskBytes >= 0
        ? capacity.freeDiskBytes
        : null,
    pinProposalPending:
      readBoundedUtf8(rootDir, join(infraDir, "transitous.lock.proposed.json")) !== null,
    crowdsourceState: "disabled-pending-review" as const,
    gbfsCatalog: inspectGbfsCatalog(rootDir, motisDir),
  };
  if (configText === null) {
    return {
      configFound: false,
      datasetCount: 0,
      realtimeFeedCount: 0,
      gbfsFeedCount: 0,
      feedProxyUrlCount: 0,
      gbfsProxyUrl: null,
      feedProxyMode: "none",
      capabilityState: capabilityError ? "error" : "missing",
      ...(capabilityError ? { capabilityError } : {}),
      configHash: null,
      ...base,
    };
  }
  let expectations: MotisConfigExpectations;
  let configError: string | undefined;
  try {
    expectations = await parseMotisConfig(configText);
  } catch {
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
    configError = "invalid MOTIS config";
  }
  const hosts = expectations.feedProxyUrls
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map((value) => {
      try {
        return new URL(value).hostname.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter((value): value is string => value !== null);
  const uniqueHosts = new Set(hosts);
  if (expectations.gbfsProxyUrl) {
    try {
      uniqueHosts.add(new URL(expectations.gbfsProxyUrl).hostname.toLowerCase());
    } catch {
      // The invalid value remains visible only as a bounded configuration status field.
    }
  }
  const hasTransitous = uniqueHosts.has("rt.triptix.tech");
  const hasOther = [...uniqueHosts].some((host) => host !== "rt.triptix.tech");
  const configHash = createHash("sha256").update(configText).digest("hex");
  const licenseHash = base.licenseHash;
  const capabilityState: MotisInventory["capabilityState"] =
    configError || capabilityError
      ? "error"
      : !snapshot
        ? "missing"
        : snapshot.artifacts.config.sha256 !== configHash ||
            snapshot.artifacts.license.sha256 !== licenseHash
          ? "stale"
          : "healthy";
  const error = configError ?? capabilityError;
  return {
    configFound: true,
    datasetCount: expectations.timetableDatasets,
    realtimeFeedCount: expectations.realtimeFeeds,
    gbfsFeedCount: expectations.gbfsFeeds,
    feedProxyUrlCount: hosts.length,
    gbfsProxyUrl: expectations.gbfsProxyUrl?.slice(0, MAX_TEXT) ?? null,
    feedProxyMode:
      uniqueHosts.size === 0
        ? "none"
        : hasTransitous && hasOther
          ? "mixed"
          : hasTransitous
            ? "transitous-cloud"
            : "self-hosted",
    capabilityState,
    ...(error ? { capabilityError: error } : {}),
    configHash,
    ...base,
  };
}

export async function inspectDataInventory(rootDir: string): Promise<DataInventory> {
  const infraDir = join(rootDir, "infra", "docker");
  const dataRoot = join(infraDir, "data");
  return {
    osm: inspectOsm(dataRoot),
    builds: inspectBuilds(dataRoot),
    motisTransitous: await inspectMotis(rootDir, infraDir, dataRoot),
  };
}
