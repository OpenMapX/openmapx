import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { privateFeedHostAllowlist, safeFetchJson } from "@openmapx/core/utils/safe-download";
import {
  type CompiledGbfsAddition,
  compileGbfsCatalog,
  type ExistingGbfsSource,
  type GbfsSourceIndexEntry,
  parseMobilityDataGbfsCsv,
} from "@openmapx/transitous-core";
import { runOpsOperation } from "../../ops-client.js";
import { scrubSecrets } from "../../utils/scrub-secrets.js";
import { readFeedOverlay } from "../transitous-feeds-overlay.js";
import type { StageFn, StageResult } from "./types.js";

interface ObservedFeedLicense {
  status: "declared" | "not-reported";
  id?: string;
  url?: string;
}

interface ValidationResult {
  sourceId: string;
  ok: boolean;
  checkedAt: string;
  version?: string;
  feedNames?: string[];
  feedLicense?: ObservedFeedLicense;
  errorClass?: "timeout" | "http" | "json" | "inventory" | "version" | "network";
  reason?: string;
}

function intEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * Ceiling for one GBFS document during candidate validation. Real feeds are a
 * few megabytes at most; the cap bounds what a hostile candidate can make the
 * daemon allocate, and a breach fails the candidate rather than truncating it.
 */
const MAX_GBFS_DOCUMENT_BYTES = 32 * 1024 * 1024;

function readExistingSources(catalogDir: string): ExistingGbfsSource[] {
  const feedsDir = join(catalogDir, "feeds");
  if (!existsSync(feedsDir)) return [];
  const sources: ExistingGbfsSource[] = [];
  for (const name of readdirSync(feedsDir)) {
    if (!name.endsWith(".json")) continue;
    const region = name.slice(0, -5).toLowerCase();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(feedsDir, name), "utf-8"));
    } catch {
      continue;
    }
    const entries = (parsed as { sources?: unknown }).sources;
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const source = raw as Record<string, unknown>;
      if (source.spec !== "gbfs" || typeof source.url !== "string") continue;
      sources.push({
        region,
        name: typeof source.name === "string" ? source.name : source.url,
        discoveryUrl: source.url,
        sourceId:
          typeof source["openmapx-source-id"] === "string"
            ? source["openmapx-source-id"]
            : undefined,
        provenance: "transitous",
      });
    }
  }
  return sources;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  return safeFetchJson<unknown>(url, {
    timeoutMs,
    maxBytes: MAX_GBFS_DOCUMENT_BYTES,
    allowPrivateHosts: privateFeedHostAllowlist(),
    headers: { "User-Agent": "openmapx-gbfs-validator" },
  });
}

function classifyValidationError(error: unknown): ValidationResult["errorClass"] {
  const errorName = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (errorName === "AbortError" || /abort|timeout/i.test(message)) return "timeout";
  if (/^HTTP \d+/.test(message)) return "http";
  if (/JSON|Unexpected token|not valid json/i.test(message)) return "json";
  if (/version/i.test(message)) return "version";
  if (/station inventory|vehicles/i.test(message)) return "inventory";
  return "network";
}

function decodeObservedLicense(value: unknown): ObservedFeedLicense {
  if (!value || typeof value !== "object") return { status: "not-reported" };
  const root = value as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
  const id =
    typeof data.license_id === "string" && data.license_id.trim()
      ? data.license_id.trim()
      : undefined;
  const url =
    typeof data.license_url === "string" && data.license_url.trim()
      ? data.license_url.trim()
      : undefined;
  return id || url ? { status: "declared", id, url } : { status: "not-reported" };
}

function discoveryFeeds(value: unknown): {
  version: string;
  feeds: Array<{ name: string; url: string }>;
} {
  if (!value || typeof value !== "object") throw new Error("discovery is not an object");
  const root = value as Record<string, unknown>;
  const version = typeof root.version === "string" ? root.version : "";
  if (!/^(2\.|3\.)/.test(version))
    throw new Error(`unsupported GBFS version ${version || "unknown"}`);
  const data = root.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") throw new Error("discovery has no data object");
  const candidates: unknown[] = [data.feeds];
  for (const language of Object.values(data)) {
    if (language && typeof language === "object")
      candidates.push((language as Record<string, unknown>).feeds);
  }
  const rawFeeds = candidates.find(Array.isArray);
  if (!Array.isArray(rawFeeds)) throw new Error("discovery has no feeds array");
  const feeds = rawFeeds.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    return typeof entry.name === "string" && typeof entry.url === "string"
      ? [{ name: entry.name, url: entry.url }]
      : [];
  });
  return { version, feeds };
}

export async function validateGbfsAddition(
  addition: CompiledGbfsAddition,
  timeoutMs: number,
  checkedAt: string,
): Promise<ValidationResult> {
  try {
    const { version, feeds } = discoveryFeeds(await fetchJson(addition.url, timeoutMs));
    // Sub-feed URLs come out of the remote discovery document, so resolve each
    // one against the document's own URL: GBFS mandates absolute URLs but real
    // feeds ship relative paths, and resolving makes the target explicit before
    // it is fetched.
    const byName = new Map(
      feeds.flatMap((feed) => {
        try {
          return [[feed.name, new URL(feed.url, addition.url).toString()] as const];
        } catch {
          return [];
        }
      }),
    );
    const stationPair = byName.get("station_information") && byName.get("station_status");
    const vehicle = byName.get("vehicle_status") ?? byName.get("free_bike_status");
    if (!stationPair && !vehicle)
      throw new Error("discovery declares neither station inventory nor vehicles");
    const required = stationPair
      ? [byName.get("station_information"), byName.get("station_status")]
      : [vehicle];
    const systemInformationUrl = byName.get("system_information");
    const [systemInformation] = await Promise.all([
      systemInformationUrl ? fetchJson(systemInformationUrl, timeoutMs) : undefined,
      ...required
        .filter((url): url is string => Boolean(url))
        .map((url) => fetchJson(url, timeoutMs)),
    ]);
    return {
      sourceId: addition.sourceId,
      ok: true,
      checkedAt,
      version,
      feedNames: [...byName.keys()].sort(),
      feedLicense: decodeObservedLicense(systemInformation),
    };
  } catch (error) {
    return {
      sourceId: addition.sourceId,
      ok: false,
      checkedAt,
      errorClass: classifyValidationError(error),
      reason: scrubSecrets(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) output[index] = await task(item);
    }
  });
  await Promise.all(workers);
  return output;
}

function readValidationCache(path: string, registrySha256: string): Map<string, ValidationResult> {
  if (!existsSync(path)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      registrySha256?: unknown;
      results?: ValidationResult[];
    };
    if (parsed.registrySha256 !== registrySha256 || !Array.isArray(parsed.results))
      return new Map();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return new Map(
      parsed.results
        .filter((entry) => Date.parse(entry.checkedAt) >= cutoff)
        .map((entry) => [entry.sourceId, entry]),
    );
  } catch {
    return new Map();
  }
}

function writeValidationCache(
  path: string,
  registrySha256: string,
  results: ValidationResult[],
): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, registrySha256, results }, null, 2)}\n`,
    "utf-8",
  );
  renameSync(temporary, path);
}

function injectAdditions(catalogDir: string, additions: CompiledGbfsAddition[]): void {
  const feedsDir = join(catalogDir, "feeds");
  mkdirSync(feedsDir, { recursive: true });
  const byRegion = new Map<string, CompiledGbfsAddition[]>();
  for (const addition of additions) {
    const values = byRegion.get(addition.region) ?? [];
    values.push(addition);
    byRegion.set(addition.region, values);
  }
  for (const [region, values] of byRegion) {
    const path = join(feedsDir, `${region}.json`);
    const parsed = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>)
      : {};
    const sources = Array.isArray(parsed.sources) ? [...parsed.sources] : [];
    for (const addition of values) {
      sources.push({
        name: addition.name,
        spec: "gbfs",
        type: "url",
        url: addition.url,
        "openmapx-source-id": addition.sourceId,
        license: addition.license,
      });
    }
    sources.sort((a, b) =>
      String((a as { name?: unknown }).name).localeCompare(String((b as { name?: unknown }).name)),
    );
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ ...parsed, sources }, null, 2)}\n`, "utf-8");
    renameSync(temporary, path);
  }
}

export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  const finish = (
    status: StageResult["status"],
    message: string,
    artifacts?: Record<string, unknown>,
  ): StageResult => ({
    stage: "compile-gbfs",
    status,
    startedAt,
    finishedAt: ctx.now(),
    durationMs: Date.now() - start,
    message,
    artifacts,
  });
  if (process.env.MOTIS_GBFS_CATALOG_ENABLED !== "true") {
    return finish("skipped", "pinned MobilityData GBFS compiler is disabled");
  }
  try {
    // The catalog lock lives under the repository's `infra/docker/`, which only
    // the operations agent may read on this service's behalf.
    const lock = await runOpsOperation({ kind: "gbfsCatalogLock.inspect" });
    const response = await fetch(lock.url, { headers: { "User-Agent": "openmapx-gbfs-compiler" } });
    if (!response.ok) throw new Error(`GBFS registry download failed: HTTP ${response.status}`);
    const csv = await response.text();
    const actualHash = createHash("sha256").update(csv).digest("hex");
    if (actualHash !== lock.sha256)
      throw new Error(`GBFS registry hash mismatch: expected ${lock.sha256}, got ${actualHash}`);

    const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
    const overlayPath =
      ctx.feedsOverlayPath ??
      process.env.TRANSITOUS_FEEDS_OVERLAY_PATH ??
      join(ctx.repoRoot, "infra", "docker", "data", "overrides", "feeds-overlay.json");
    const overlay = existsSync(overlayPath) ? readFeedOverlay(overlayPath) : null;
    const compiled = compileGbfsCatalog({
      rows: parseMobilityDataGbfsCsv(csv),
      countries: ctx.countries,
      existingSources: readExistingSources(catalogDir),
      quarantine: overlay?.quarantine ?? [],
      maxAdditions: intEnv("MOTIS_GBFS_CATALOG_MAX_ADDITIONS", 50),
    });
    const checkedAt = ctx.now();
    const timeoutMs = intEnv("MOTIS_GBFS_CATALOG_TIMEOUT_MS", 5_000);
    const cachePath = join(ctx.dataDir, ".gbfs-validation-cache.json");
    const cache = readValidationCache(cachePath, lock.sha256);
    const uncached = compiled.additions.filter((addition) => !cache.has(addition.sourceId));
    const freshValidations = await mapConcurrent(
      uncached,
      intEnv("MOTIS_GBFS_CATALOG_CONCURRENCY", 4),
      (addition) => validateGbfsAddition(addition, timeoutMs, checkedAt),
    );
    const freshById = new Map(freshValidations.map((result) => [result.sourceId, result]));
    const validations = compiled.additions
      .map((addition) => cache.get(addition.sourceId) ?? freshById.get(addition.sourceId))
      .filter((result): result is ValidationResult => Boolean(result));
    writeValidationCache(cachePath, lock.sha256, validations);
    const validIds = new Set(
      validations.filter((result) => result.ok).map((result) => result.sourceId),
    );
    const healthy = compiled.additions.filter((addition) => validIds.has(addition.sourceId));
    const failed = validations.filter((result) => !result.ok);
    const ratio = validations.length === 0 ? 0 : failed.length / validations.length;
    if (ratio > floatEnv("MOTIS_GBFS_CATALOG_MAX_FAILURE_RATIO", 0.35)) {
      const failureDetails = failed
        .map(
          (result) =>
            `${result.sourceId} [${result.errorClass ?? "unknown"}]: ${result.reason ?? "unknown error"}`,
        )
        .join("; ");
      throw new Error(
        `GBFS validation failure ratio ${ratio.toFixed(3)} exceeds configured threshold; failed sources: ${failureDetails}`,
      );
    }
    injectAdditions(catalogDir, healthy);
    const failedById = new Map(failed.map((result) => [result.sourceId, result]));
    const sources: GbfsSourceIndexEntry[] = compiled.sourceIndex.map((source) => {
      const failure = failedById.get(source.sourceId);
      return failure
        ? { ...source, status: "excluded", exclusionReason: "validation" as const }
        : source;
    });
    const validationById = new Map(validations.map((result) => [result.sourceId, result]));
    const indexedSources = sources.map((source) => {
      const validation = validationById.get(source.sourceId);
      return {
        ...source,
        observation: validation
          ? validation.ok
            ? {
                state: "validated" as const,
                checkedAt: validation.checkedAt,
                lastObservedSuccess: validation.checkedAt,
                dataAge: "unknown" as const,
                feedLicense: validation.feedLicense ?? { status: "not-reported" as const },
              }
            : {
                state: "validation-failed" as const,
                checkedAt: validation.checkedAt,
                lastErrorAt: validation.checkedAt,
                lastErrorClass: validation.errorClass ?? "network",
                dataAge: "unknown" as const,
              }
          : { state: "unknown" as const, dataAge: "unknown" as const },
      };
    });
    const normalizedCountries = ctx.countries.map((country) => country.toLowerCase());
    const index = {
      schemaVersion: 1,
      generatedAt: checkedAt,
      lock,
      summary: {
        ...compiled.summary,
        validated: validations.length,
        healthy: healthy.length,
        failed: failed.length,
      },
      validations,
      sources: indexedSources,
      regionalCanaries: [
        "de",
        "at",
        "ch",
        normalizedCountries.find((country) => !["de", "at", "ch"].includes(country)),
      ]
        .filter(
          (country, index, all): country is string =>
            Boolean(country) && all.indexOf(country) === index,
        )
        .map((country) => ({
          country,
          status: normalizedCountries.includes(country)
            ? indexedSources.some(
                (source) =>
                  source.country === country &&
                  (source.status === "included" || source.exclusionReason === "duplicate"),
              )
              ? "configured"
              : "configured-no-healthy-addition"
            : "not-configured",
        })),
    };
    const output = join(catalogDir, "out", "gbfs-source-index.json");
    mkdirSync(join(catalogDir, "out"), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
    renameSync(temporary, output);
    ctx.state.gbfsCompilation = {
      output,
      healthy: healthy.length,
      failed: failed.length,
      registrySha256: lock.sha256,
    };
    return finish("ok", `compiled ${healthy.length} healthy pinned GBFS addition(s)`, {
      sourceIndexPath: output,
      registrySha256: lock.sha256,
      summary: index.summary,
    });
  } catch (error) {
    return finish("error", (error as Error).message, { failure: (error as Error).message });
  }
};
