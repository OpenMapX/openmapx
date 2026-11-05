import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type TransitSourceLifecycle as CanonicalTransitSourceLifecycle,
  type TransitSourceListQuery as CanonicalTransitSourceListQuery,
  type TransitSourceListResult as CanonicalTransitSourceListResult,
  type TransitSourceRow as CanonicalTransitSourceRow,
  type TransitCatalogSource,
  transitLicenseSchema,
} from "@openmapx/core/data-manager-contracts";
import { CANDIDATE_MANIFEST_FILENAME, readCandidateManifest } from "./jobs/transitous/candidate.js";
import {
  buildTransitlandAtlasSpecIndex,
  countryOfRegion,
  scheduleSourcesForFeed,
  type TransitousFeedFile,
} from "./jobs/transitous/internal.js";
import {
  readTransitSourceManifest,
  safeOriginUrl,
  TRANSIT_SOURCE_MANIFEST_FILENAME,
  type TransitSourceManifestRecord,
} from "./jobs/transitous/source-manifest.js";
import {
  applyFeedOverlay,
  type FeedFile,
  type FeedOverlay,
  type FeedOverlayGtfsSource,
  operatorSourceId,
  parseFeedOverlay,
  readFeedOverlay,
  writeFeedOverlayAtomic,
} from "./jobs/transitous-feeds-overlay.js";

export type TransitSourceLifecycle = CanonicalTransitSourceLifecycle;

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

export type TransitSourceRow = CanonicalTransitSourceRow;
export type TransitSourceListQuery = CanonicalTransitSourceListQuery;
export type TransitSourceListResult = CanonicalTransitSourceListResult;

export class TransitSourceError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 = 400,
    readonly code?: "source_action_not_allowed",
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
      return {
        region,
        // A crashed pipeline can leave overlay-injected sources in the
        // catalog clone; the overlay is re-applied in memory below, so
        // leftovers must not be double-counted as pinned catalog entries.
        sources: (value.sources ?? []).filter((source) => !source["openmapx-source-id"]),
      };
    });
}

/**
 * Desired schedule sources derived through the same overlay application and
 * atlas-aware resolution the pipeline itself uses, so desired and active
 * (manifest) rows are directly comparable. `countries` scopes catalog rows to
 * the deployment's configured pipeline scope; operator rows stay visible even
 * out of scope so a stale entry can still be removed.
 */
function desiredSources(
  catalogDir: string,
  overlay: FeedOverlay,
  countries?: string[],
): DesiredSource[] {
  const feeds = rawCatalog(catalogDir);
  applyFeedOverlay(feeds, overlay);
  const quarantined = new Set(overlay.quarantine.map((entry) => entry.sourceId));
  // Project retained quarantined operators in isolation: their very reason
  // for quarantine may be a collision with the pinned catalog. They remain
  // visible for removal without ever being materialized into that catalog.
  const retained: FeedFile[] = [];
  applyFeedOverlay(retained, {
    version: 3,
    sources: overlay.sources.filter(
      (source) =>
        source.spec === "gtfs" && quarantined.has(operatorSourceId(source.region, source.name)),
    ),
    patches: [],
    quarantine: [],
  });
  feeds.push(...retained);
  const atlasSpecIndex = buildTransitlandAtlasSpecIndex(catalogDir);
  const scope = (countries ?? []).map((country) => country.toLowerCase());
  const sources: DesiredSource[] = feeds.flatMap((feed) => {
    const country = countryOfRegion(feed.region);
    return scheduleSourcesForFeed(
      feed.region,
      country,
      feed as TransitousFeedFile,
      atlasSpecIndex,
    ).flatMap((entry) => {
      if (scope.length > 0 && entry.origin === "catalog" && !scope.includes(country)) return [];
      return [
        {
          id: entry.sourceId,
          region: entry.region,
          name: entry.name,
          format: entry.format,
          origin: entry.origin,
          originUrl: entry.originUrl,
          license: structuredClone(entry.license ?? {}),
          requested: entry.requested && !quarantined.has(entry.sourceId),
        },
      ];
    });
  });
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

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function transitSourceRevision(options: {
  catalogDir: string;
  overlayPath: string;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        catalog: rawCatalog(options.catalogDir),
        overlay: readOverlay(options.overlayPath),
      }),
    )
    .digest("hex");
}
function guardedOverlayPersistence(
  options: { catalogDir: string; overlayPath: string; expectedSourceRevision?: string },
  candidate: FeedOverlay,
): () => void {
  const revision = transitSourceRevision(options);
  if (options.expectedSourceRevision && options.expectedSourceRevision !== revision)
    throw new TransitSourceError("Desired transit sources changed. Refresh before applying.", 409);
  return () => {
    if (transitSourceRevision(options) !== revision)
      throw new TransitSourceError(
        "Desired transit sources changed. Refresh before applying.",
        409,
      );
    persistOverlay(options.overlayPath, candidate);
  };
}
function equivalentDesiredActive(
  desired: DesiredSource,
  active: TransitSourceManifestRecord,
): boolean {
  // Format is derived from the acquired artifact on the active side (a mirror
  // netex fallback), so it is not part of the desired/active identity. The
  // manifest URL is credential-sanitized; sanitize the desired URL the same
  // way before comparing.
  return (
    desired.region === active.region &&
    desired.name === active.name &&
    desired.origin === active.origin &&
    stableStringify(desired.license ?? {}) === stableStringify(active.license ?? {}) &&
    (safeOriginUrl(desired.originUrl) ?? "") === (active.originUrl ?? "")
  );
}

export function listTransitSources(options: {
  dataDir: string;
  catalogDir: string;
  overlayPath: string;
  countries?: string[];
  feedStates?: TransitFeedStateEvidence[];
  query?: TransitSourceListQuery;
}): TransitSourceListResult {
  const overlay = readOverlay(options.overlayPath),
    sourceRevision = transitSourceRevision(options),
    active = activeEvidence(options.dataDir);
  const scope = (options.countries ?? []).map((country) => country.toLowerCase());
  const desired = desiredSources(options.catalogDir, overlay).filter(
    (source) =>
      source.origin === "operator" ||
      scope.length === 0 ||
      scope.includes(countryOfRegion(source.region)) ||
      active.sources.has(source.id) ||
      overlay.patches.some((patch) => patch.sourceId === source.id),
  );
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
      license: transitLicenseSchema.parse(base.license ?? {}),
      requested,
      sourceRevision,
      desiredState: !desiredSource ? "removed" : requested ? "enabled" : "disabled",
      actions: {
        enable:
          !!desiredSource &&
          !requested &&
          (scope.length === 0 || scope.includes(countryOfRegion(base.region))) &&
          !overlay.quarantine.some((entry) => entry.sourceId === id),
        disable: !!desiredSource && requested,
        remove: desiredSource?.origin === "operator",
        reason: !desiredSource
          ? "Source metadata is no longer retained."
          : overlay.quarantine.some((entry) => entry.sourceId === id)
            ? "Source is quarantined."
            : scope.length > 0 && !scope.includes(countryOfRegion(base.region))
              ? "Outside configured country scope."
              : null,
      },
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
  const country = query.country?.toLowerCase();
  if (country) rows = rows.filter((row) => countryOfRegion(row.region) === country);
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
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const total = rows.length;
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 500);
  const offset = Math.max(Math.floor(query.offset ?? 0), 0);
  return { sourceRevision, sources: rows.slice(offset, offset + limit), total, limit, offset };
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
  countries?: string[];
  expectedSourceRevision?: string;
}): { sourceId: string; persist: () => void } {
  if (options.countries?.length) {
    const scope = options.countries.map((country) => country.toLowerCase());
    const country = countryOfRegion(options.source.region);
    if (!scope.includes(country)) {
      throw new TransitSourceError(
        `Region ${options.source.region} is outside the configured country scope ` +
          `(${scope.join(", ")}); the pipeline would never import this source`,
      );
    }
  }
  const initialRevision = transitSourceRevision(options);
  const current = readOverlay(options.overlayPath);
  const candidate = parseFeedOverlay({
    ...current,
    sources: [...current.sources, options.source],
  });
  validateOverlayAgainstCatalog(options.catalogDir, candidate);
  const sourceId = operatorSourceId(options.source.region.toLowerCase(), options.source.name);
  return {
    sourceId,
    persist: guardedOverlayPersistence(
      { ...options, expectedSourceRevision: options.expectedSourceRevision ?? initialRevision },
      candidate,
    ),
  };
}

export function prepareRemoveTransitSource(options: {
  catalogDir: string;
  overlayPath: string;
  sourceId: string;
  countries?: string[];
  expectedSourceRevision?: string;
}): { sourceId: string; persist: () => void } {
  const initialRevision = transitSourceRevision(options);
  const current = readOverlay(options.overlayPath);
  if (!options.sourceId.startsWith("operator:")) {
    throw new TransitSourceError(
      "Pinned catalog sources can be disabled, but cannot be removed",
      409,
      "source_action_not_allowed",
    );
  }
  const sources = current.sources.filter(
    (source) =>
      source.spec !== "gtfs" || operatorSourceId(source.region, source.name) !== options.sourceId,
  );
  if (sources.length === current.sources.length)
    throw new TransitSourceError(`Operator source ${options.sourceId} not found`, 404);
  const candidate: FeedOverlay = {
    ...current,
    sources,
    patches: current.patches.filter((patch) => patch.sourceId !== options.sourceId),
    quarantine: current.quarantine.filter((entry) => entry.sourceId !== options.sourceId),
  };
  const validated = parseFeedOverlay(candidate);
  return {
    sourceId: options.sourceId,
    persist: guardedOverlayPersistence(
      { ...options, expectedSourceRevision: options.expectedSourceRevision ?? initialRevision },
      validated,
    ),
  };
}

export function prepareSetTransitSourceEnabled(options: {
  catalogDir: string;
  overlayPath: string;
  sourceId: string;
  enabled: boolean;
  countries?: string[];
  expectedSourceRevision?: string;
}): { sourceId: string; persist: () => void } {
  const initialRevision = transitSourceRevision(options);
  const current = readOverlay(options.overlayPath);
  // Look outside the configured scope for deactivation. A retained source must
  // remain removable/disableable after an operator narrows the deployment.
  const known = desiredSources(options.catalogDir, current).find(
    (source) => source.id === options.sourceId,
  );
  if (!known) throw new TransitSourceError(`Transit source ${options.sourceId} not found`, 404);
  if (options.enabled && current.quarantine.some((entry) => entry.sourceId === options.sourceId))
    throw new TransitSourceError(
      "Source is quarantined; repair it before enabling",
      409,
      "source_action_not_allowed",
    );
  if (
    options.enabled &&
    options.countries?.length &&
    !options.countries
      .map((country) => country.toLowerCase())
      .includes(countryOfRegion(known.region))
  )
    throw new TransitSourceError(
      "Source is outside the configured country scope",
      409,
      "source_action_not_allowed",
    );
  const candidate = parseFeedOverlay({
    ...current,
    patches: [
      ...current.patches.filter((patch) => patch.sourceId !== options.sourceId),
      { sourceId: options.sourceId, skip: !options.enabled },
    ],
  });
  validateOverlayAgainstCatalog(options.catalogDir, candidate);
  return {
    sourceId: options.sourceId,
    persist: guardedOverlayPersistence(
      { ...options, expectedSourceRevision: options.expectedSourceRevision ?? initialRevision },
      candidate,
    ),
  };
}
export function prepareEnableTransitSource(options: {
  catalogDir: string;
  overlayPath: string;
  sourceId: string;
  countries?: string[];
  expectedSourceRevision?: string;
}): { sourceId: string; persist: () => void } {
  return prepareSetTransitSourceEnabled({ ...options, enabled: true });
}

/** Called by the fixed durable transit-sync dispatcher after original target admission. */
export function prepareTransitSourceMutation(
  options: { catalogDir: string; overlayPath: string; countries?: string[] },
  input: import("@openmapx/core/data-manager-contracts").TransitDesiredSourceMutation,
) {
  if (input.action === "add")
    return prepareAddTransitSource({
      ...options,
      expectedSourceRevision: input.expectedSourceRevision,
      source: { ...input.source, spec: "gtfs", type: "http", origin: "operator" },
    });
  if (input.action === "remove")
    return prepareRemoveTransitSource({
      ...options,
      sourceId: input.sourceId,
      expectedSourceRevision: input.expectedSourceRevision,
    });
  return prepareSetTransitSourceEnabled({
    ...options,
    sourceId: input.sourceId,
    enabled: input.action === "enable",
    expectedSourceRevision: input.expectedSourceRevision,
  });
}
export function listPinnedTransitCatalog(
  catalogDir: string,
  countries?: string[],
): TransitCatalogSource[] {
  return desiredSources(catalogDir, emptyOverlay(), countries).map(
    ({ requested: _requested, origin: _origin, ...source }) => ({
      ...source,
      license: transitLicenseSchema.parse(source.license),
    }),
  );
}
