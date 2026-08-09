import type { BoundingBox, OverpassFilter, TagPredicate } from "@openmapx/core";
import {
  DEFAULT_CONFLATION_THRESHOLDS,
  fusePoiResults,
  OverpassTimeoutError,
  rankPoiResults,
  removeFilterPredicate,
  toPoiSearchOutcome,
} from "@openmapx/core";
import { buildOpeningHoursInfo } from "@openmapx/core/server";
import { httpError, type IntegrationContext } from "@openmapx/integration-framework";
import { getPresetById } from "@openmapx/presets";
import type { PoiSearchProvider, PoiSearchResult, PoiSearchReturn } from "./types.js";

/**
 * What every orchestrator search returns.
 *
 * `partial` means something went wrong (a provider failed, or the bbox had to
 * be shrunk to beat a timeout). `truncated` means nothing went wrong but the
 * area simply holds more matches than are being returned — a normal, expected
 * state that the client still has to be told about, or it presents a selection
 * as the complete answer. `total` is the exact number of matches in the area,
 * and is deliberately absent whenever it could not be counted for exactly the
 * requested bbox — see `finalize`.
 */
export interface PoiSearchResponse {
  results: PoiSearchResult[];
  partial: boolean;
  truncated: boolean;
  total?: number;
}

const MAX_SHRINK_RETRIES = 3;
const SHRINK_FACTOR = 0.6;
const PRESET_PREFIX = "preset:";
const PRESET_SENTINEL = "__preset__";
// Id of the authoritative base POI provider (OSM via Overpass); all other
// matching providers are treated as augments to its result set.
const BASE_PROVIDER_ID = "overpass";

interface ConflationLinkRow {
  osm_type: string;
  osm_id: number | bigint;
  gers_id: string;
}

/**
 * Builds a `Map<"${osm_type}/${osm_id}", gers_id>` by batch-querying
 * `overture_places.poi_conflation_link` for the given OSM result set.
 *
 * Issues a single query for the entire result set (no N+1). Returns `undefined`
 * when `ctx.db` is absent (no PostGIS) or when there are no OSM results with
 * a parseable osm_type/osm_id — callers treat `undefined` as "no link, run
 * scored spatial matching only".
 */
async function buildConflationLinkMap(
  ctx: IntegrationContext,
  osmResults: PoiSearchResult[],
): Promise<Map<string, string> | undefined> {
  if (!ctx.db) return undefined;

  type OsmParsed = { type: string; id: bigint };
  const parsed: OsmParsed[] = [];
  for (const r of osmResults) {
    if (!r.id.startsWith("osm:")) continue;
    const rest = r.id.slice(4);
    const slash = rest.indexOf("/");
    if (slash < 0) continue;
    const type = rest.slice(0, slash);
    const rawId = rest.slice(slash + 1);
    const numId = Number(rawId);
    if (!Number.isFinite(numId) || numId <= 0) continue;
    parsed.push({ type, id: BigInt(numId) });
  }

  if (parsed.length === 0) return undefined;

  try {
    const rows = await ctx.db.execute<ConflationLinkRow[]>(
      `SELECT osm_type, osm_id, gers_id
         FROM overture_places.poi_conflation_link
        WHERE (osm_type, osm_id) IN (${parsed.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(",")})`,
      parsed.flatMap((p) => [p.type, p.id]),
    );
    if (!Array.isArray(rows) || rows.length === 0) return undefined;
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(`${row.osm_type}/${row.osm_id}`, row.gers_id);
    }
    return map.size > 0 ? map : undefined;
  } catch {
    return undefined;
  }
}

// Progressive relaxation: when a structured filter returns fewer than this many
// results, drop attribute (`require`) predicates one at a time so an
// over-specific NL query still surfaces near-misses instead of nothing. Each
// drop is one more Overpass round-trip, so the number of drops is capped.
const RELAX_MIN_RESULTS = 5;
const MAX_RELAX_DROPS = 4;

function shrinkBbox(bbox: BoundingBox, factor: number): BoundingBox {
  const centerLat = (bbox.north + bbox.south) / 2;
  const centerLon = (bbox.east + bbox.west) / 2;
  const halfLat = ((bbox.north - bbox.south) / 2) * factor;
  const halfLon = ((bbox.east - bbox.west) / 2) * factor;
  return {
    south: centerLat - halfLat,
    north: centerLat + halfLat,
    west: centerLon - halfLon,
    east: centerLon + halfLon,
  };
}

/** One provider's answer, before ranking and the public result cap. */
interface ProviderRun {
  results: PoiSearchResult[];
  partial: boolean;
  truncated: boolean;
}

const EMPTY_RUN: ProviderRun = { results: [], partial: false, truncated: false };
const FAILED_RUN: ProviderRun = { results: [], partial: true, truncated: false };

async function runWithShrink(
  fn: (bbox: BoundingBox) => Promise<PoiSearchReturn>,
  bbox: BoundingBox,
): Promise<ProviderRun> {
  let currentBbox = bbox;
  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = toPoiSearchOutcome(await fn(currentBbox));
      for (const r of outcome.results) {
        if (r.openingHours && !r.openingHoursInfo) {
          r.openingHoursInfo = buildOpeningHoursInfo(r.openingHours, {
            lat: r.coordinates[1],
            lon: r.coordinates[0],
          });
        }
      }
      return {
        results: outcome.results,
        partial: attempt > 0,
        truncated: outcome.truncated ?? false,
      };
    } catch (err) {
      if (err instanceof OverpassTimeoutError && attempt < MAX_SHRINK_RETRIES) {
        currentBbox = shrinkBbox(currentBbox, SHRINK_FACTOR);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Rank a provider run, apply the public cap, and describe what was left out.
 *
 * `total` is only reported when it is an exact count *for the requested bbox*.
 * Two things spoil that and both must withhold it, since the response is
 * publicly cached and a wrong total is worse than none: a provider ceiling
 * turns it into a floor, and a timeout shrink turns it into a count for a
 * smaller box than the caller asked about.
 */
function finalize(run: ProviderRun, bbox: BoundingBox): PoiSearchResponse {
  const ranked = rankPoiResults(run.results, bbox);
  const totalIsExact = !run.truncated && !run.partial;
  return {
    results: ranked.results,
    partial: run.partial,
    truncated: run.truncated || ranked.truncated,
    ...(totalIsExact ? { total: ranked.total } : {}),
  };
}

export function createPoiSearchOrchestrator(ctx: IntegrationContext) {
  function getProviders(): PoiSearchProvider[] {
    const integrations = ctx.getIntegrationsByDomain("poi-search");
    const providers: PoiSearchProvider[] = [];
    for (const integration of integrations) {
      const registered = (integration.providers.get("poi-search") ?? []) as PoiSearchProvider[];
      providers.push(...registered);
    }
    return providers;
  }

  async function search(
    category: unknown,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchResponse> {
    if (typeof category !== "string" || category.length === 0) {
      throw httpError(400, "Missing or invalid category");
    }

    const providers = getProviders();

    let osmTags: Record<string, string> | undefined;
    let lookupCategory = category;

    if (category.startsWith(PRESET_PREFIX)) {
      const presetId = category.slice(PRESET_PREFIX.length);
      const preset = getPresetById(presetId);
      if (!preset) {
        throw httpError(400, `Unknown preset: ${presetId}`);
      }
      osmTags = preset.tags;
      lookupCategory = PRESET_SENTINEL;
    }

    const matching = providers.filter((p) => p.categories.includes(lookupCategory));
    if (matching.length === 0) {
      throw httpError(400, `Unknown category: ${category}`);
    }

    if (matching.length === 1) {
      const provider = matching[0];
      const run = await runWithShrink(
        (currentBbox) =>
          provider.search(lookupCategory, currentBbox, { lang: options?.lang, osmTags }),
        bbox,
      );
      return finalize(run, bbox);
    }

    // The OSM/Overpass provider is the authoritative base set; every other
    // matching provider augments it (Overture gap-fill today). The split keys
    // off the base provider's id.
    const overpassIdx = matching.findIndex((p) => p.id === BASE_PROVIDER_ID);
    const augmentProviders = matching.filter((p) => p.id !== BASE_PROVIDER_ID);

    const baseResult =
      overpassIdx >= 0
        ? await runWithShrink(
            (currentBbox) =>
              matching[overpassIdx].search(lookupCategory, currentBbox, {
                lang: options?.lang,
                osmTags,
              }),
            bbox,
          ).catch((err: unknown) => {
            if (err instanceof OverpassTimeoutError) throw err;
            return FAILED_RUN;
          })
        : EMPTY_RUN;

    const augmentSettled = await Promise.all(
      augmentProviders.map((p) =>
        runWithShrink(
          (currentBbox) => p.search(lookupCategory, currentBbox, { lang: options?.lang, osmTags }),
          bbox,
        ).catch(() => FAILED_RUN),
      ),
    );

    const osmResults = baseResult.results;
    const augmentResults = augmentSettled.flatMap((s) => s.results);

    const linkMap = await buildConflationLinkMap(ctx, osmResults);

    const fused = fusePoiResults(
      osmResults,
      augmentResults,
      DEFAULT_CONFLATION_THRESHOLDS,
      linkMap,
    );
    return finalize(
      {
        results: fused,
        partial: baseResult.partial || augmentSettled.some((s) => s.partial),
        truncated: baseResult.truncated || augmentSettled.some((s) => s.truncated),
      },
      bbox,
    );
  }

  async function searchText(
    query: unknown,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchResponse> {
    if (typeof query !== "string" || query.trim().length === 0) {
      throw httpError(400, "Missing or empty query");
    }
    const provider = getProviders().find((p) => typeof p.searchText === "function");
    const searchTextFn = provider?.searchText;
    if (!searchTextFn) {
      throw httpError(400, "No text-search provider available");
    }

    const run = await runWithShrink(
      (currentBbox) => searchTextFn.call(provider, query, currentBbox, { lang: options?.lang }),
      bbox,
    );
    return finalize(run, bbox);
  }

  async function searchFiltered(
    category: unknown,
    attributes: Record<string, string>,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchResponse> {
    if (typeof category !== "string" || category.length === 0) {
      throw Object.assign(new Error("Missing or invalid category"), { statusCode: 400 });
    }
    const provider = getProviders().find(
      (p) => typeof p.searchFiltered === "function" && p.categories.includes(category),
    );
    const searchFilteredFn = provider?.searchFiltered;
    if (!searchFilteredFn) {
      throw Object.assign(new Error(`No filtered-search provider for category: ${category}`), {
        statusCode: 400,
      });
    }

    const run = await runWithShrink(
      (currentBbox) =>
        searchFilteredFn.call(provider, category, attributes, currentBbox, {
          lang: options?.lang,
        }),
      bbox,
    );
    return finalize(run, bbox);
  }

  async function searchByFilter(
    filter: OverpassFilter,
    bbox: BoundingBox,
    options?: { lang?: string },
  ): Promise<PoiSearchResponse & { relaxed: TagPredicate[] }> {
    const provider = getProviders().find((p) => typeof p.searchByFilter === "function");
    const searchByFilterFn = provider?.searchByFilter;
    if (!searchByFilterFn) {
      throw httpError(400, "No filter-search provider available");
    }

    const runFilter = (f: OverpassFilter) =>
      runWithShrink(
        (currentBbox) => searchByFilterFn.call(provider, f, currentBbox, { lang: options?.lang }),
        bbox,
      );

    const full = await runFilter(filter);
    // Enough exact matches, or no attribute predicates to drop — return as-is.
    if (full.results.length >= RELAX_MIN_RESULTS || (filter.require?.length ?? 0) === 0) {
      return { ...finalize(full, bbox), relaxed: [] };
    }

    // Too few exact matches: progressively drop `require` predicates from the
    // end (never the category selectors) until we clear the threshold or run
    // out of allowed drops.
    let working = filter;
    let best = full;
    const relaxed: TagPredicate[] = [];
    const maxDrops = Math.min(filter.require?.length ?? 0, MAX_RELAX_DROPS);
    for (let i = 0; i < maxDrops; i++) {
      const reqs = working.require;
      if (!reqs || reqs.length === 0) break;
      relaxed.push(reqs[reqs.length - 1]);
      working = removeFilterPredicate(working, "require", reqs.length - 1);
      const next = await runFilter(working);
      best = { ...next, partial: best.partial || next.partial };
      if (best.results.length >= RELAX_MIN_RESULTS) break;
    }

    // Relaxing only helps when it surfaced more than the strict query did. If it
    // never did (e.g. the area is simply empty), keep the strict results and
    // report no relaxation so the UI doesn't claim filters were ignored.
    if (best.results.length > full.results.length) {
      return { ...finalize(best, bbox), relaxed };
    }
    return { ...finalize(full, bbox), relaxed: [] };
  }

  return { search, searchText, searchFiltered, searchByFilter, getProviders };
}
