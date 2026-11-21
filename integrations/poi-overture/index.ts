import type { BoundingBox, OvertureAddressItem, OvertureSourceItem } from "@openmapx/core";
import {
  captureOvertureFieldContributors,
  cleanOvertureString,
  createPlace,
  normalizeOvertureProvenance,
  OVERTURE_COMMERCIAL_CATEGORIES,
  openMapXCategoryToOvertureConcepts,
  overtureTaxonomyToOpenMapX,
  selectFirstOvertureString,
  selectOvertureAddress,
  selectOvertureName,
  selectOvertureStrings,
} from "@openmapx/core";
import { overtureTaxonomyCategoryEvidence } from "@openmapx/core/places/overtureCategoryMap";
import type { DatabaseClient, IntegrationContext } from "@openmapx/integration-framework";
import type {
  CategoryId,
  PoiSearchOutcome,
  PoiSearchProvider,
  PoiSearchResult,
} from "@openmapx/integration-poi-search/types";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForRecords,
  parseContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { registerPlaceResolver } from "@openmapx/place-ids";

interface OvertureRow {
  canonical_id?: string | null;
  gers_id: string;
  name: string;
  longitude: number;
  latitude: number;
  basic_category: string | null;
  taxonomy_primary: string | null;
  taxonomy_hierarchy: string[] | null;
  taxonomy_alternates: string[] | null;
  names: OvertureNames | null;
  addresses: OvertureAddressItem[] | null;
  websites: string[] | null;
  socials: string[] | null;
  emails: string[] | null;
  phones: string[] | null;
  brand: OvertureBrand | null;
  sources: OvertureSourceItem[] | null;
  sources_catalogue: Attribution[];
  release: string;
}

interface OvertureNames {
  primary?: string;
  common?: Record<string, string> | null;
}

interface OvertureBrand {
  names?: OvertureNames | null;
  wikidata?: string | null;
}

interface OvertureHealthRow {
  place_count: number | string;
  place_release: string | null;
  state_release: string | null;
  status: string | null;
  phase: string | null;
  updated_at: Date | string | null;
  last_error: string | null;
}

export function localizedOvertureName(
  names: OvertureNames | null,
  fallback: string,
  lang?: string,
): { name: string; variants?: Record<string, string> } {
  const { name, variants } = selectOvertureName(names, fallback, lang);
  return { name, variants };
}

export function normalizeOvertureAddress(addresses: OvertureAddressItem[] | null): {
  address?: string;
  city?: string;
  countryCode?: string;
} {
  const { address, city, countryCode } = selectOvertureAddress(addresses);
  return { address, city, countryCode };
}

function normalizeBrand(brand: OvertureBrand | null, lang?: string) {
  if (!brand) return undefined;
  const selected = selectOvertureName(brand.names ?? null, "", lang);
  if (!selected.name) return undefined;
  const wikidata = cleanOvertureString(brand.wikidata);
  return {
    brand: { name: selected.name, wikidata },
    namePointer: `/brand${selected.property}`,
  };
}

interface SelectedOvertureFields {
  namePointer: string;
  brandNamePointer?: string;
  phonePointer?: string;
  emailPointer?: string;
  websitePointer?: string;
  socialPointers?: string[];
  addressPointers: { address?: string[]; city?: string[]; countryCode?: string[] };
}

function overtureRowToPoiSearchResult(
  row: OvertureRow,
  requestedCategory?: CategoryId,
  lang?: string,
): PoiSearchResult {
  const localized = selectOvertureName(
    row.names,
    cleanOvertureString(row.name) ?? row.gers_id,
    lang,
  );
  const address = selectOvertureAddress(row.addresses);
  const brandSelection = normalizeBrand(row.brand, lang);
  const brand = brandSelection?.brand;
  const phone = selectFirstOvertureString(row.phones, "/phones");
  const email = selectFirstOvertureString(row.emails, "/emails");
  const website = selectFirstOvertureString(row.websites, "/websites");
  const socials = selectOvertureStrings(row.socials, "/socials");
  const osmTags: Record<string, string> = {};
  if (brand?.name) osmTags.brand = brand.name;
  if (brand?.wikidata) osmTags["brand:wikidata"] = brand.wikidata;

  const category =
    requestedCategory ??
    overtureTaxonomyToOpenMapX({
      basicCategory: row.basic_category,
      primary: row.taxonomy_primary,
      hierarchy: row.taxonomy_hierarchy,
      alternates: row.taxonomy_alternates,
    });

  const result: PoiSearchResult = {
    id: row.canonical_id ?? `overture:${row.gers_id}`,
    gersId: row.gers_id,
    name: localized.name,
    coordinates: [row.longitude, row.latitude],
    category: category ?? undefined,
    address: address.address,
    phone: phone?.value,
    email: email?.value,
    website: website?.value,
    socials: socials?.values,
    brand,
    names: localized.variants,
    provenance: normalizeOvertureProvenance(row.sources, row.release),
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  };
  return captureRowContributors(result, row, {
    namePointer: localized.property,
    brandNamePointer: brandSelection?.namePointer,
    phonePointer: phone?.pointer,
    emailPointer: email?.pointer,
    websitePointer: website?.pointer,
    socialPointers: socials?.pointers,
    addressPointers: address.pointers,
  });
}

function captureRowContributors<T extends PoiSearchResult | ReturnType<typeof createPlace>>(
  record: T,
  row: OvertureRow,
  selected: SelectedOvertureFields,
): T {
  const catalogue = parseContributors(row.sources_catalogue) ?? [];
  const pointers: Record<string, string[]> = {
    coordinates: ["/geometry"],
    name: [selected.namePointer],
  };
  if (selected.phonePointer) pointers.phone = [selected.phonePointer];
  if (selected.emailPointer) pointers.email = [selected.emailPointer];
  if (selected.websitePointer) pointers.website = [selected.websitePointer];
  if (record.address && selected.addressPointers.address) {
    pointers.address = selected.addressPointers.address;
  }
  if (record.countryCode && selected.addressPointers.countryCode) {
    pointers.countryCode = selected.addressPointers.countryCode;
  }
  if ("city" in record && record.city && selected.addressPointers.city) {
    pointers.city = selected.addressPointers.city;
  }
  if (selected.socialPointers?.length) pointers.socials = selected.socialPointers;
  if (record.names) {
    pointers.names = [];
    for (const key of Object.keys(record.names)) {
      const pointer = `/names/common/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      pointers[`names.${key}`] = [pointer];
      pointers.names.push(pointer);
    }
  }
  if (record.brand) {
    pointers["brand.name"] = selected.brandNamePointer ? [selected.brandNamePointer] : [];
    pointers.brand = [...pointers["brand.name"]];
    if (record.brand.wikidata) {
      pointers.brand.push("/brand/wikidata");
      pointers["brand.wikidata"] = ["/brand/wikidata"];
    }
  }
  if (record.category)
    pointers.category = overtureTaxonomyCategoryEvidence(
      {
        basicCategory: row.basic_category,
        primary: row.taxonomy_primary,
        hierarchy: row.taxonomy_hierarchy,
        alternates: row.taxonomy_alternates,
      },
      record.category,
    ).propertyPointers;
  for (const key of Object.keys(record.osmTags ?? {})) {
    pointers[`osmTags.${key}`] =
      key === "brand"
        ? selected.brandNamePointer
          ? [selected.brandNamePointer]
          : []
        : key === "brand:wikidata"
          ? ["/brand/wikidata"]
          : (pointers[key] ?? []);
  }
  const captured = captureOvertureFieldContributors(record, row.sources, catalogue, pointers);
  const overture = snapshotContributors(
    catalogue.filter((receipt) => receipt.sourceId === "overture"),
  );
  captured.fieldContributors.gersId = overture;
  if ("ids" in record) {
    captured.fieldContributors["ids.overture"] = overture;
    // A conflation link supplies an OSM identity, not OpenStreetMap field data.
    if (record.ids?.osm) captured.fieldContributors["ids.osm"] = overture;
  }
  captured.contributors = contributorsForRecords(
    Object.values(captured.fieldContributors).map((contributors) => ({ contributors })),
  );
  return captured;
}

/**
 * Rows fetched per bbox query. Ordered nearest-first, so this is a candidate
 * pool the orchestrator narrows further — one row beyond it is fetched so
 * hitting the ceiling is detectable and can be reported as truncation. Kept
 * above the display cap so this augment source still has something to
 * contribute after fusion with OSM.
 */
const OVERTURE_FETCH_LIMIT = 500;

async function queryOverturePlaces(
  db: DatabaseClient,
  opts: { bbox: BoundingBox; concepts: string[]; lang?: string; minConfidence: number },
): Promise<OvertureRow[]> {
  const { bbox, concepts, minConfidence } = opts;
  const sql = `
    SELECT
      (SELECT 'osm:' || link.osm_type || '/' || link.osm_id::TEXT
       FROM overture_places.poi_conflation_link link
       WHERE link.gers_id = places.gers_id AND link.release = places.release) AS canonical_id,
      gers_id,
      name,
      ST_X(geom) AS longitude,
      ST_Y(geom) AS latitude,
      basic_category,
      taxonomy_primary,
      taxonomy_hierarchy,
      taxonomy_alternates,
      names,
      addresses,
      websites,
      socials,
      emails,
      phones,
      brand,
      sources,
      state.sources_catalogue,
      places.release
    FROM overture_places.places
    JOIN overture_places.conflation_state AS state
      ON state.singleton = 1 AND state.release = places.release
    WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      AND (operating_status IS NULL OR operating_status = 'open')
      AND (confidence IS NULL OR confidence >= $6)
      AND (
        basic_category = ANY($5::TEXT[])
        OR taxonomy_primary = ANY($5::TEXT[])
        OR taxonomy_hierarchy && $5::TEXT[]
        OR taxonomy_alternates && $5::TEXT[]
      )
    ORDER BY
      geom <-> ST_SetSRID(ST_MakePoint(($1 + $3) / 2, ($2 + $4) / 2), 4326),
      confidence DESC NULLS LAST,
      ((NULLIF(BTRIM(COALESCE(addresses->0->>'freeform', '')), '') IS NOT NULL)::INT +
       (EXISTS (SELECT 1 FROM unnest(websites) AS v WHERE BTRIM(v) <> ''))::INT +
       (EXISTS (SELECT 1 FROM unnest(phones) AS v WHERE BTRIM(v) <> ''))::INT +
       (EXISTS (SELECT 1 FROM unnest(emails) AS v WHERE BTRIM(v) <> ''))::INT) DESC,
      gers_id
    LIMIT ${OVERTURE_FETCH_LIMIT + 1}
  `;
  const params: unknown[] = [bbox.west, bbox.south, bbox.east, bbox.north, concepts, minConfidence];
  return db.execute<OvertureRow[]>(sql, params);
}

async function fetchOverturePlaceByGers(
  db: DatabaseClient,
  gers: string,
  _lang?: string,
): Promise<OvertureRow | null> {
  const rows = await db.execute<OvertureRow[]>(
    `SELECT
       (SELECT 'osm:' || link.osm_type || '/' || link.osm_id::TEXT
        FROM overture_places.poi_conflation_link link
        WHERE link.gers_id = places.gers_id AND link.release = places.release) AS canonical_id,
       gers_id,
       name,
       ST_X(geom) AS longitude,
       ST_Y(geom) AS latitude,
       basic_category,
       taxonomy_primary,
       taxonomy_hierarchy,
       taxonomy_alternates,
       names,
       addresses,
       websites,
       socials,
       emails,
       phones,
       brand,
       sources,
       state.sources_catalogue,
       places.release
     FROM overture_places.places
     JOIN overture_places.conflation_state AS state
       ON state.singleton = 1 AND state.release = places.release
     WHERE gers_id = $1
     LIMIT 1`,
    [gers],
  );
  return rows[0] ?? null;
}

function overtureRowToPlace(row: OvertureRow, lang?: string) {
  const localized = selectOvertureName(
    row.names,
    cleanOvertureString(row.name) ?? row.gers_id,
    lang,
  );
  const address = selectOvertureAddress(row.addresses);
  const brandSelection = normalizeBrand(row.brand, lang);
  const brand = brandSelection?.brand;
  const phone = selectFirstOvertureString(row.phones, "/phones");
  const email = selectFirstOvertureString(row.emails, "/emails");
  const website = selectFirstOvertureString(row.websites, "/websites");
  const socials = selectOvertureStrings(row.socials, "/socials");
  const osmTags: Record<string, string> = {};
  if (brand?.name) osmTags.brand = brand.name;
  if (brand?.wikidata) osmTags["brand:wikidata"] = brand.wikidata;
  if (email?.value) osmTags.email = email.value;

  const category = overtureTaxonomyToOpenMapX({
    basicCategory: row.basic_category,
    primary: row.taxonomy_primary,
    hierarchy: row.taxonomy_hierarchy,
    alternates: row.taxonomy_alternates,
  });

  const osmId = row.canonical_id?.match(/^osm:((?:node|way|relation)\/\d+)$/)?.[1];
  const place = createPlace({
    primaryScheme: osmId ? "osm" : "overture",
    ids: { overture: row.gers_id, ...(osmId ? { osm: osmId } : {}) },
    name: localized.name,
    address: address.address ?? "",
    city: address.city,
    countryCode: address.countryCode,
    coordinates: [row.longitude, row.latitude],
    category: category ?? undefined,
    phone: phone?.value,
    email: email?.value,
    website: website?.value,
    socials: socials?.values,
    brand,
    names: localized.variants,
    provenance: normalizeOvertureProvenance(row.sources, row.release),
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  });
  return captureRowContributors(place, row, {
    namePointer: localized.property,
    brandNamePointer: brandSelection?.namePointer,
    phonePointer: phone?.pointer,
    emailPointer: email?.pointer,
    websitePointer: website?.pointer,
    socialPointers: socials?.pointers,
    addressPointers: address.pointers,
  });
}

let boundDb: DatabaseClient | undefined;

function bindDb(db: DatabaseClient): void {
  boundDb = db;
}

export const overtureProvider: PoiSearchProvider = {
  id: "overture",
  categories: [...OVERTURE_COMMERCIAL_CATEGORIES],
  async search(
    category: string,
    bbox: BoundingBox,
    _options?: {
      lang?: string;
      filters?: Record<string, unknown>;
      osmTags?: Record<string, string>;
    },
  ): Promise<PoiSearchOutcome> {
    const concepts = openMapXCategoryToOvertureConcepts(category);
    if (!concepts.length) return { results: [], truncated: false };
    if (!boundDb) return { results: [], truncated: false };
    const rows = await queryOverturePlaces(boundDb, {
      bbox,
      concepts,
      lang: _options?.lang,
      // Calibrated to 0.5 (was 0.7): the sweep showed 0.7 excludes most genuine
      // places; matches the offline conflation candidate floor.
      minConfidence: 0.5,
    });
    const truncated = rows.length > OVERTURE_FETCH_LIMIT;
    const kept = truncated ? rows.slice(0, OVERTURE_FETCH_LIMIT) : rows;
    return {
      results: kept.map((row) =>
        overtureRowToPoiSearchResult(row, category as CategoryId, _options?.lang),
      ),
      truncated,
    };
  },
};

export function setup(ctx: IntegrationContext): void {
  const db = ctx.db;
  if (!db) {
    ctx.log.warn("[poi-overture] ctx.db undefined — manifest must require postgis");
    return;
  }
  bindDb(db);

  ctx.registerHealthCheck(async () => {
    try {
      const rows = await db.execute<OvertureHealthRow[]>(
        `SELECT
           state.place_count,
           (SELECT release FROM overture_places.places LIMIT 1) AS place_release,
           state.release AS state_release, state.status, state.phase,
           state.updated_at, state.last_error
         FROM overture_places.conflation_state AS state
         WHERE state.singleton = 1`,
      );
      const state = rows[0];
      if (!state || Number(state.place_count) <= 0) {
        return { status: "down" as const, error: "overture_places is empty" };
      }
      if (state.place_release !== state.state_release) {
        return {
          status: "down" as const,
          error: `Overture release mismatch: places=${state.place_release}, state=${state.state_release}`,
        };
      }
      const updatedAt = state.updated_at ? new Date(state.updated_at).getTime() : 0;
      if (
        state.status === "running" &&
        (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 30 * 60 * 1000)
      ) {
        return {
          status: "up" as const,
          error: `Places available; conflation ${state.phase ?? "unknown"} heartbeat is stale`,
        };
      }
      if (state.status !== "completed" || state.phase !== "complete") {
        return {
          status: "up" as const,
          error:
            `Places available; conflation is ${state.status ?? "unknown"}` +
            (state.phase ? ` in ${state.phase}` : "") +
            (state.last_error ? `: ${state.last_error}` : ""),
        };
      }
      return { status: "up" as const };
    } catch {
      return { status: "down" as const, error: "overture_places not ingested" };
    }
  });

  ctx.registerPoiSearchProvider(overtureProvider);

  registerPlaceResolver("overture", async (gers, rctx) => {
    const row = await fetchOverturePlaceByGers(db, gers, rctx.lang);
    if (!row) return null;
    return overtureRowToPlace(row, rctx.lang);
  });
}
