import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CANDIDATE_MANIFEST_FILENAME, readCandidateManifest } from "./jobs/transitous/candidate.js";
import {
  readTransitSourceManifest,
  TRANSIT_SOURCE_MANIFEST_FILENAME,
  type TransitSourceManifestRecord,
} from "./jobs/transitous/source-manifest.js";
import {
  applyFeedOverlay,
  catalogSourceId,
  type FeedFile,
  type FeedOverlay,
  type FeedOverlayGtfsSource,
  operatorSourceId,
  parseFeedOverlay,
  readFeedOverlay,
  writeFeedOverlayAtomic,
} from "./jobs/transitous-feeds-overlay.js";

export type TransitSourceLifecycle =
  | "active"
  | "add-pending"
  | "update-pending"
  | "removal-pending"
  | "disabled"
  | "failed"
  | "stale";

export interface TransitFeedStateEvidence {
  region: string;
  name: string;
  lastFetchedAt?: Date | null;
  lastImportedAt?: Date | null;
  hash?: string | null;
  validationStatus?: string | null;
  validationMessage?: string | null;
  status?: string | null;
}

export interface TransitSourceRow {
  id: string;
  region: string;
  name: string;
  format: "gtfs" | "netex";
  origin: "catalog" | "operator";
  originUrl?: string;
  license: Record<string, unknown>;
  requested: boolean;
  active: boolean;
  activeEpoch?: string;
  artifact?: {
    path: string;
    sha256: string;
    sizeBytes: number;
    retrievedAt: string;
  };
  lastFetchedAt?: string;
  lastImportedAt?: string;
  validationStatus?: string;
  validationMessage?: string;
  lifecycle: TransitSourceLifecycle;
}

export interface TransitSourceListQuery {
  search?: string;
  lifecycle?: TransitSourceLifecycle;
  origin?: "catalog" | "operator";
  limit?: number;
  offset?: number;
}

export interface TransitSourceListResult {
  sources: TransitSourceRow[];
  total: number;
  limit: number;
  offset: number;
}

export class TransitSourceError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

interface DesiredSource {
  id: string;
  region: string;
  name: string;
  format: "gtfs" | "netex";
  origin: "catalog" | "operator";
  originUrl?: string;
  license: Record<string, unknown>;
  requested: boolean;
}

interface CatalogSourceRecord extends Record<string, unknown> {
  name?: string;
  spec?: string;
  skip?: boolean;
  url?: string;
  "url-override"?: string;
  license?: Record<string, unknown>;
}

function emptyOverlay(): FeedOverlay {
  return { version: 3, sources: [], patches: [], quarantine: [] };
}

export function resolveTransitOverlayPath(dataDir: string, explicit?: string): string {
  return (
    explicit ??
    process.env.TRANSITOUS_FEEDS_OVERLAY_PATH ??
    join(dataDir, "overrides", "feeds-overlay.json")
  );
}

function readOverlay(path: string): FeedOverlay {
  return readFeedOverlay(path) ?? emptyOverlay();
}

function rawCatalog(catalogDir: string): FeedFile[] {
  const feedsDir = join(catalogDir, "feeds");
  if (!existsSync(feedsDir))
    throw new TransitSourceError("Pinned Transitous catalog is unavailable", 409);
  return readdirSync(feedsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((fileName) => {
      const region = fileName.slice(0, -".json".length);
      const value = JSON.parse(readFileSync(join(feedsDir, fileName), "utf-8")) as {
        sources?: CatalogSourceRecord[];
      };
      return { region, sources: value.sources ?? [] };
    });
}

function desiredSources(catalogDir: string, overlay: FeedOverlay): DesiredSource[] {
  const feeds = rawCatalog(catalogDir);
  const patches = new Map(overlay.patches.map((patch) => [patch.sourceId, patch.skip]));
  const sources: DesiredSource[] = feeds.flatMap((feed) =>
    (feed.sources ?? []).flatMap((raw) => {
      const source = raw as CatalogSourceRecord;
      const format = (source.spec ?? "gtfs").toLowerCase();
      if (format !== "gtfs" && format !== "netex") return [];
      if (!source.name) return [];
      const id = catalogSourceId(feed.region, source.name);
      return [
        {
          id,
          region: feed.region,
          name: source.name,
          format,
          origin: "catalog" as const,
          originUrl: source["url-override"] ?? source.url,
          license: structuredClone(source.license ?? {}),
          requested: !(patches.get(id) ?? source.skip ?? false),
        },
      ];
    }),
  );
  for (const source of overlay.sources) {
    if (source.spec !== "gtfs") continue;
    sources.push({
      id: operatorSourceId(source.region, source.name),
      region: source.region,
      name: source.name,
      format: "gtfs",
      origin: "operator",
      originUrl: source.url,
      license: {
        ...(source.license.spdxIdentifier
          ? { "spdx-identifier": source.license.spdxIdentifier }
          : {}),
        ...(source.license.url ? { url: source.license.url } : {}),
        "attribution-text": source.license.attribution,
        ...(source.license.publisher ? { publisher: source.license.publisher } : {}),
        ...(source.license.publisherUrl ? { "publisher-url": source.license.publisherUrl } : {}),
      },
      requested: true,
    });
  }
  return sources.sort((a, b) => a.id.localeCompare(b.id));
}

function activeEvidence(dataDir: string): {
  epoch?: string;
  sources: Map<string, TransitSourceManifestRecord>;
} {
  const liveDir = join(dataDir, "motis", "live");
  const sourcePath = join(liveDir, TRANSIT_SOURCE_MANIFEST_FILENAME);
  if (!existsSync(sourcePath)) return { sources: new Map() };
  const sourceManifest = readTransitSourceManifest(sourcePath);
  const candidatePath = join(liveDir, CANDIDATE_MANIFEST_FILENAME);
  const epoch = existsSync(candidatePath) ? readCandidateManifest(liveDir).epoch : undefined;
  return {
    epoch,
    sources: new Map(sourceManifest.sources.map((source) => [source.sourceId, source])),
  };
}

function equivalentDesiredActive(
  desired: DesiredSource,
  active: TransitSourceManifestRecord,
): boolean {
  return (
    desired.region === active.region &&
    desired.name === active.name &&
    desired.format === active.format &&
    desired.origin === active.origin &&
    JSON.stringify(desired.license) === JSON.stringify(active.license) &&
    (desired.originUrl ?? "") === (active.originUrl ?? "")
  );
}

export function listTransitSources(options: {
  dataDir: string;
  catalogDir: string;
  overlayPath: string;
  feedStates?: TransitFeedStateEvidence[];
  query?: TransitSourceListQuery;
}): TransitSourceListResult {
  const desired = desiredSources(options.catalogDir, readOverlay(options.overlayPath));
  const active = activeEvidence(options.dataDir);
  const byId = new Map<string, DesiredSource | undefined>(
    desired.map((source) => [source.id, source]),
  );
  for (const id of active.sources.keys()) if (!byId.has(id)) byId.set(id, undefined);
  const stateByKey = new Map(
    (options.feedStates ?? []).map((state) => [
      `${state.region.toLowerCase()}\u0000${state.name.toLowerCase()}`,
      state,
    ]),
  );
  let rows: TransitSourceRow[] = [...byId.entries()].map(([id, desiredSource]) => {
    const activeSource = active.sources.get(id);
    const base = desiredSource ?? activeSource;
    if (!base) throw new Error(`Transit source ${id} has no desired or active evidence`);
    const requested = desiredSource?.requested === true;
    const isActive = activeSource !== undefined;
    const feedState = stateByKey.get(
      `${base.region.toLowerCase()}\u0000${base.name.toLowerCase()}`,
    );
    let lifecycle: TransitSourceLifecycle;
    if (requested && feedState?.status === "failed") lifecycle = "failed";
    else if (requested && feedState?.status === "stale") lifecycle = "stale";
    else if (
      requested &&
      isActive &&
      desiredSource &&
      activeSource &&
      !equivalentDesiredActive(desiredSource, activeSource)
    )
      lifecycle = "update-pending";
    else if (requested && isActive) lifecycle = "active";
    else if (requested) lifecycle = "add-pending";
    else if (isActive) lifecycle = "removal-pending";
    else lifecycle = "disabled";
    return {
      id,
      region: base.region,
      name: base.name,
      format: base.format,
      origin: base.origin,
      ...(base.originUrl ? { originUrl: base.originUrl } : {}),
      license: structuredClone(base.license ?? {}),
      requested,
      active: isActive,
      ...(isActive && active.epoch ? { activeEpoch: active.epoch } : {}),
      ...(activeSource
        ? {
            artifact: {
              path: activeSource.artifact.relativePath,
              sha256: activeSource.artifact.sha256,
              sizeBytes: activeSource.artifact.sizeBytes,
              retrievedAt: activeSource.artifact.modifiedAt,
            },
          }
        : {}),
      ...(feedState?.lastFetchedAt ? { lastFetchedAt: feedState.lastFetchedAt.toISOString() } : {}),
      ...(feedState?.lastImportedAt
        ? { lastImportedAt: feedState.lastImportedAt.toISOString() }
        : {}),
      ...(feedState?.validationStatus ? { validationStatus: feedState.validationStatus } : {}),
      ...(feedState?.validationMessage ? { validationMessage: feedState.validationMessage } : {}),
      lifecycle,
    };
  });
  const query = options.query ?? {};
  if (query.origin) rows = rows.filter((source) => source.origin === query.origin);
  if (query.lifecycle) rows = rows.filter((source) => source.lifecycle === query.lifecycle);
  if (query.search?.trim()) {
    const needle = query.search.trim().toLowerCase();
    rows = rows.filter((source) =>
      [source.id, source.region, source.name, source.originUrl ?? ""].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }
  const total = rows.length;
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 100), 1), 500);
  const offset = Math.max(Math.floor(query.offset ?? 0), 0);
  return { sources: rows.slice(offset, offset + limit), total, limit, offset };
}

function validateOverlayAgainstCatalog(catalogDir: string, overlay: FeedOverlay): void {
  applyFeedOverlay(rawCatalog(catalogDir), overlay);
}

function persistOverlay(path: string, overlay: FeedOverlay): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFeedOverlayAtomic(path, overlay);
}

export function prepareAddTransitSource(options: {
  catalogDir: string;
  overlayPath: string;
  source: FeedOverlayGtfsSource;
}): { sourceId: string; persist: () => void } {
  const current = readOverlay(options.overlayPath);
  const candidate = parseFeedOverlay({
    ...current,
    sources: [...current.sources, options.source],
  });
  validateOverlayAgainstCatalog(options.catalogDir, candidate);
  const sourceId = operatorSourceId(options.source.region.toLowerCase(), options.source.name);
  return { sourceId, persist: () => persistOverlay(options.overlayPath, candidate) };
}

export function prepareRemoveTransitSource(options: {
  catalogDir: string;
  overlayPath: string;
  sourceId: string;
}): { sourceId: string; persist: () => void } {
  const current = readOverlay(options.overlayPath);
  let candidate: FeedOverlay;
  if (options.sourceId.startsWith("operator:")) {
    const sources = current.sources.filter(
      (source) =>
        source.spec !== "gtfs" || operatorSourceId(source.region, source.name) !== options.sourceId,
    );
    if (sources.length === current.sources.length) {
      throw new TransitSourceError(`Operator source ${options.sourceId} not found`, 404);
    }
    candidate = { ...current, sources };
  } else if (options.sourceId.startsWith("catalog:")) {
    const known = desiredSources(options.catalogDir, current).some(
      (source) => source.origin === "catalog" && source.id === options.sourceId,
    );
    if (!known) throw new TransitSourceError(`Catalog source ${options.sourceId} not found`, 404);
    candidate = {
      ...current,
      patches: [
        ...current.patches.filter((patch) => patch.sourceId !== options.sourceId),
        { sourceId: options.sourceId, skip: true },
      ],
    };
  } else {
    throw new TransitSourceError(`Unsupported transit source identity ${options.sourceId}`);
  }
  const validated = parseFeedOverlay(candidate);
  return {
    sourceId: options.sourceId,
    persist: () => persistOverlay(options.overlayPath, validated),
  };
}

export function prepareEnableTransitSource(options: {
  catalogDir: string;
  overlayPath: string;
  sourceId: string;
}): { sourceId: string; persist: () => void } {
  if (!options.sourceId.startsWith("catalog:")) {
    throw new TransitSourceError("Only pinned catalog sources can be re-enabled");
  }
  const current = readOverlay(options.overlayPath);
  const known = desiredSources(options.catalogDir, current).some(
    (source) => source.origin === "catalog" && source.id === options.sourceId,
  );
  if (!known) throw new TransitSourceError(`Catalog source ${options.sourceId} not found`, 404);
  const candidate = parseFeedOverlay({
    ...current,
    patches: [
      ...current.patches.filter((patch) => patch.sourceId !== options.sourceId),
      { sourceId: options.sourceId, skip: false },
    ],
  });
  return {
    sourceId: options.sourceId,
    persist: () => persistOverlay(options.overlayPath, candidate),
  };
}

export function listPinnedTransitCatalog(catalogDir: string): Array<{
  id: string;
  region: string;
  name: string;
  format: "gtfs" | "netex";
  originUrl?: string;
  license: Record<string, unknown>;
}> {
  return desiredSources(catalogDir, emptyOverlay()).map(
    ({ requested: _requested, origin: _origin, ...source }) => source,
  );
}
