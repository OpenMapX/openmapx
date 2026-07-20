import { existsSync, mkdirSync, renameSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MotisOperationsPolicy } from "./operations-profile.js";
import { writeSovereignSourceManifest } from "./source-manifest.js";
import type { StageFn, StageResult } from "./types.js";

const GIB = 1024 ** 3;

export interface MotisCapacityInput {
  freeDiskBytes: number;
  freeInodes?: number;
  slotMemoryGb: number;
  slotCpu: number;
  fileDescriptorLimit: number;
  buildTimeoutHours: number;
}

export interface MotisInputEstimate {
  feedCount: number;
  measuredCompressedBytes: number;
  compressedBytes: number;
  expandedGtfsBytes: number;
  importedMotisBytes: number;
  osmBytes: number;
  proxyCacheBytes: number;
  requiredDiskBytes: number;
  basis: "measured-and-conservative" | "conservative-defaults";
}

export interface MotisPreflightResult {
  ok: boolean;
  policy: MotisOperationsPolicy;
  estimate: MotisInputEstimate;
  capacity: MotisCapacityInput;
  blockers: string[];
  warnings: string[];
}

export interface RunMotisPreflightInput {
  policy: MotisOperationsPolicy;
  feedCount: number;
  measuredCompressedBytes?: number;
  osmBytes?: number;
  osmAvailable: boolean;
  capacity: MotisCapacityInput;
  selectedFeedIds?: string[];
  sourceUrls?: string[];
  selectedSources?: Array<{
    id: string;
    originUrl?: string;
    license?: Record<string, unknown>;
  }>;
}

function hasDeclaredLicense(license: Record<string, unknown> | undefined): boolean {
  if (!license) return false;
  return Object.values(license).some(
    (value) => (typeof value === "string" && value.trim().length > 0) || typeof value === "boolean",
  );
}

export function estimateMotisInputs(input: {
  policy: MotisOperationsPolicy;
  feedCount: number;
  measuredCompressedBytes?: number;
  osmBytes?: number;
}): MotisInputEstimate {
  const measured = Math.max(0, input.measuredCompressedBytes ?? 0);
  const compressed = Math.max(measured, input.feedCount * 25 * 1024 ** 2);
  const expanded = compressed * 4;
  const imported = expanded * 1.75;
  const osm = input.osmBytes ?? (input.policy.profile === "planet" ? 90 * GIB : 4 * GIB);
  const proxy = Math.max(512 * 1024 ** 2, compressed * 0.25);
  const oneGeneration = compressed + expanded + imported + osm + proxy;
  // Active + full candidate + retained rollback generations, with 20% headroom.
  const required = oneGeneration * (2 + input.policy.retentionGenerations) * 1.2;
  return {
    feedCount: input.feedCount,
    measuredCompressedBytes: measured,
    compressedBytes: compressed,
    expandedGtfsBytes: expanded,
    importedMotisBytes: imported,
    osmBytes: osm,
    proxyCacheBytes: proxy,
    requiredDiskBytes: Math.ceil(required),
    basis: measured > 0 ? "measured-and-conservative" : "conservative-defaults",
  };
}

export function runMotisPreflight(input: RunMotisPreflightInput): MotisPreflightResult {
  const estimate = estimateMotisInputs(input);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (
    input.policy.profile !== "planet" &&
    input.policy.countries.length === 0 &&
    input.policy.feedAllowList.length === 0
  ) {
    blockers.push("regional profiles require explicit countries or a feed allow-list");
  }
  if (input.feedCount < 1) blockers.push("no timetable feeds selected");
  if (input.feedCount > input.policy.maxFeedCount) {
    blockers.push(
      `selected ${input.feedCount} feeds exceeds profile maximum ${input.policy.maxFeedCount}`,
    );
  }
  if (input.policy.feedAllowList.length > 0) {
    const allowed = new Set(input.policy.feedAllowList);
    const outside = (input.selectedFeedIds ?? []).filter((id) => !allowed.has(id.toLowerCase()));
    if (outside.length > 0) blockers.push(`feeds outside allow-list: ${outside.sort().join(", ")}`);
  }
  if (input.policy.profile === "regional-sovereign") {
    const sources = input.selectedSources ?? [];
    const urls =
      sources.length > 0
        ? sources.map((source) => source.originUrl).filter((url): url is string => Boolean(url))
        : (input.sourceUrls ?? []);
    const hosted = urls.filter((url) => {
      try {
        return new URL(url).hostname.endsWith("transitous.org");
      } catch {
        return true;
      }
    });
    if (hosted.length > 0) blockers.push("sovereign input contains hosted/invalid Transitous URLs");
    const missingOrigins = sources.filter((source) => !source.originUrl).map((source) => source.id);
    if (missingOrigins.length > 0) {
      blockers.push(`sovereign sources missing origin URLs: ${missingOrigins.sort().join(", ")}`);
    }
    const missingLicenses = sources
      .filter((source) => !hasDeclaredLicense(source.license))
      .map((source) => source.id);
    if (missingLicenses.length > 0) {
      blockers.push(
        `sovereign sources missing license metadata: ${missingLicenses.sort().join(", ")}`,
      );
    }
  }
  if (!input.osmAvailable && input.policy.profile !== "regional-assisted") {
    blockers.push("selected sovereign/planet profile requires a matching local OSM input");
  } else if (!input.osmAvailable) {
    warnings.push("no matching OSM input was found; street routing may be unavailable");
  }
  if (input.capacity.freeDiskBytes < estimate.requiredDiskBytes) {
    blockers.push(
      `insufficient disk: requires ${estimate.requiredDiskBytes} bytes including candidate/rollback headroom`,
    );
  }
  const minimumInodes = Math.max(100_000, input.feedCount * 1_000);
  if (input.capacity.freeInodes !== undefined && input.capacity.freeInodes < minimumInodes) {
    blockers.push(`insufficient free inodes: ${input.capacity.freeInodes} < ${minimumInodes}`);
  }
  if (input.capacity.slotMemoryGb < input.policy.resourceEnvelope.minimumMemoryGb) {
    blockers.push(
      `slot memory ${input.capacity.slotMemoryGb} GB is below profile minimum ${input.policy.resourceEnvelope.minimumMemoryGb} GB`,
    );
  }
  if (input.capacity.slotCpu < input.policy.resourceEnvelope.minimumCpu) {
    blockers.push(
      `slot CPU ${input.capacity.slotCpu} is below profile minimum ${input.policy.resourceEnvelope.minimumCpu}`,
    );
  }
  if (input.capacity.fileDescriptorLimit < Math.max(4096, input.feedCount * 8)) {
    blockers.push("file-descriptor limit is too low for the selected feed count");
  }
  if (input.capacity.buildTimeoutHours < input.policy.updateCadenceHours / 2) {
    warnings.push("build timeout is short relative to the profile update cadence");
  }
  if (estimate.basis === "conservative-defaults") {
    warnings.push("size estimate uses conservative defaults until measured history is available");
  }
  return {
    ok: blockers.length === 0,
    policy: input.policy,
    estimate,
    capacity: input.capacity,
    blockers,
    warnings,
  };
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  const finish = (status: StageResult["status"], result: MotisPreflightResult): StageResult => ({
    stage: "preflight",
    status,
    startedAt,
    finishedAt: ctx.now(),
    durationMs: Date.now() - start,
    message: result.ok ? "MOTIS resource/input preflight passed" : result.blockers.join("; "),
    artifacts: result as unknown as Record<string, unknown>,
  });

  const filesystem = statfsSync(ctx.dataDir);
  const measuredCompressedBytes = (ctx.state.selectedFeedFiles ?? []).reduce((sum, feed) => {
    const candidate = join(ctx.outDir, `${feed.id}.gtfs.zip`);
    return sum + (existsSync(candidate) ? statSync(candidate).size : 0);
  }, 0);
  const osmInput = ctx.operationsPolicy.osmInput;
  const osmCandidates = osmInput
    ? [join(ctx.outDir, osmInput), join(ctx.motisDataDir, osmInput)]
    : [];
  const osmPath = osmCandidates.find(existsSync);
  const result = runMotisPreflight({
    policy: ctx.operationsPolicy,
    feedCount: ctx.state.selectedCount ?? ctx.state.selectedFeedFiles?.length ?? 0,
    measuredCompressedBytes,
    osmBytes: osmPath ? statSync(osmPath).size : undefined,
    osmAvailable: Boolean(osmPath),
    capacity: {
      // Measured from the data volume by default. Overridable (like the other
      // capacity inputs below) for environments where statfs doesn't reflect the
      // real quota — a containerized slot, a network mount, or a CI runner where
      // unit tests drive the pipeline and must not depend on incidental free disk.
      freeDiskBytes: envNumber("MOTIS_FREE_DISK_BYTES", filesystem.bavail * filesystem.bsize),
      freeInodes: filesystem.ffree,
      slotMemoryGb: envNumber("MOTIS_SLOT_MEMORY_GB", 16),
      slotCpu: envNumber("MOTIS_SLOT_CPU", 4),
      fileDescriptorLimit: envNumber("MOTIS_FILE_DESCRIPTOR_LIMIT", 65_536),
      buildTimeoutHours: envNumber("MOTIS_BUILD_TIMEOUT_HOURS", 12),
    },
    selectedFeedIds: [...(ctx.state.expectedFeedIds ?? [])],
    selectedSources: (ctx.state.selectedFeedFiles ?? []).flatMap((feed) =>
      feed.activeScheduleSources.map((source) => ({
        id: source.id,
        originUrl: source.originUrl,
        license: source.license,
      })),
    ),
  });
  const statusPath = join(ctx.dataDir, "motis", "preflight.json");
  mkdirSync(join(ctx.dataDir, "motis"), { recursive: true });
  const temporary = `${statusPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ checkedAt: ctx.now(), ...result }, null, 2)}\n`);
  renameSync(temporary, statusPath);
  if (result.ok) writeSovereignSourceManifest(ctx);
  return finish(result.ok ? "ok" : "error", result);
};
