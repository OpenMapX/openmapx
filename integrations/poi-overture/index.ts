import type { BoundingBox } from "@openmapx/core";
import {
  createPlace,
  OVERTURE_COMMERCIAL_CATEGORIES,
  openMapXCategoryToOvertureConcepts,
  overtureTaxonomyToOpenMapX,
} from "@openmapx/core";
import type { DatabaseClient, IntegrationContext } from "@openmapx/integration-framework";
import type {
  CategoryId,
  PoiSearchProvider,
  PoiSearchResult,
} from "@openmapx/integration-poi-search/types";
import { registerPlaceResolver } from "@openmapx/place-ids";

interface OvertureRow {
  gers_id: string;
  name: string;
  longitude: number;
  latitude: number;
  basic_category: string | null;
  taxonomy_primary: string | null;
  taxonomy_hierarchy: string[] | null;
  taxonomy_alternates: string[] | null;
  names: OvertureNames | null;
  addresses: OvertureAddress[] | null;
  websites: string[] | null;
  socials: string[] | null;
  emails: string[] | null;
  phones: string[] | null;
  brand: OvertureBrand | null;
}

interface OvertureNames {
  primary?: string;
  common?: Record<string, string> | null;
}

interface OvertureAddress {
  freeform?: string | null;
  locality?: string | null;
  postcode?: string | null;
  region?: string | null;
  country?: string | null;
}

interface OvertureBrand {
  names?: OvertureNames | null;
  wikidata?: string | null;
}

function firstNonEmpty(values: string[] | null): string | undefined {
  return values?.find((value) => value.trim().length > 0)?.trim();
}

export function localizedOvertureName(
  names: OvertureNames | null,
  fallback: string,
  lang?: string,
): { name: string; variants?: Record<string, string> } {
  const common = names?.common ?? undefined;
  let localized: string | undefined;
  if (lang && common) {
    const requested = lang.toLowerCase();
    const base = requested.split("-")[0];
    localized =
      Object.entries(common).find(([tag]) => tag.toLowerCase() === requested)?.[1] ??
      Object.entries(common).find(([tag]) => tag.toLowerCase() === base)?.[1] ??
      Object.entries(common).find(([tag]) => tag.toLowerCase().split("-")[0] === base)?.[1];
  }
  return {
    name: localized?.trim() || names?.primary?.trim() || fallback,
    variants: common && Object.keys(common).length > 0 ? common : undefined,
  };
}

export function normalizeOvertureAddress(addresses: OvertureAddress[] | null): {
  address?: string;
  city?: string;
  countryCode?: string;
} {
  const value = addresses?.[0];
  if (!value) return {};
  const freeform = value.freeform?.trim();
  const locality = value.locality?.trim();
  const postcode = value.postcode?.trim();
  const localityLine = [postcode, locality].filter(Boolean).join(" ");
  const normalizedFreeform = freeform?.toLocaleLowerCase();
  const includeLocalityLine =
    localityLine.length > 0 && !normalizedFreeform?.includes(localityLine.toLocaleLowerCase());
  return {
    address:
      [freeform, includeLocalityLine ? localityLine : undefined].filter(Boolean).join(", ") ||
      undefined,
    city: locality || undefined,
    countryCode: value.country?.toLowerCase() || undefined,
  };
}

function normalizeBrand(brand: OvertureBrand | null, lang?: string) {
  if (!brand) return undefined;
  const name = localizedOvertureName(brand.names ?? null, "", lang).name;
  if (!name) return undefined;
  return { name, wikidata: brand.wikidata ?? undefined };
}

function overtureRowToPoiSearchResult(
  row: OvertureRow,
  requestedCategory?: CategoryId,
  lang?: string,
): PoiSearchResult {
  const localized = localizedOvertureName(row.names, row.name || row.gers_id, lang);
  const address = normalizeOvertureAddress(row.addresses);
  const brand = normalizeBrand(row.brand, lang);
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

  return {
    id: `overture:${row.gers_id}`,
    gersId: row.gers_id,
    name: localized.name,
    coordinates: [row.longitude, row.latitude],
    category: category ?? undefined,
    address: address.address,
    phone: firstNonEmpty(row.phones),
    email: firstNonEmpty(row.emails),
    website: firstNonEmpty(row.websites),
    socials: row.socials ?? undefined,
    brand,
    names: localized.variants,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
  };
}

async function queryOverturePlaces(
  db: DatabaseClient,
  opts: { bbox: BoundingBox; concepts: string[]; lang?: string; minConfidence: number },
): Promise<OvertureRow[]> {
  const { bbox, concepts, minConfidence } = opts;
  const sql = `
    SELECT
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
      brand
    FROM overture_places.places
    WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      AND (operating_status IS NULL OR operating_status <> 'permanently_closed')
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
      ((addresses IS NOT NULL)::INT + (websites IS NOT NULL)::INT +
       (phones IS NOT NULL)::INT + (emails IS NOT NULL)::INT) DESC,
      gers_id
    LIMIT 200
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
       brand
     FROM overture_places.places
     WHERE gers_id = $1
     LIMIT 1`,
    [gers],
  );
  return rows[0] ?? null;
}

function overtureRowToPlace(row: OvertureRow, lang?: string) {
  const localized = localizedOvertureName(row.names, row.name || row.gers_id, lang);
  const address = normalizeOvertureAddress(row.addresses);
  const brand = normalizeBrand(row.brand, lang);
  const osmTags: Record<string, string> = {};
  if (brand?.name) osmTags.brand = brand.name;
  if (brand?.wikidata) osmTags["brand:wikidata"] = brand.wikidata;
  const email = firstNonEmpty(row.emails);
  if (email) osmTags.email = email;

  const category = overtureTaxonomyToOpenMapX({
    basicCategory: row.basic_category,
    primary: row.taxonomy_primary,
    hierarchy: row.taxonomy_hierarchy,
    alternates: row.taxonomy_alternates,
  });

  return createPlace({
    primaryScheme: "overture",
    ids: { overture: row.gers_id },
    name: localized.name,
    address: address.address ?? "",
    city: address.city,
    countryCode: address.countryCode,
    coordinates: [row.longitude, row.latitude],
    category: category ?? undefined,
    phone: firstNonEmpty(row.phones),
    email,
    website: firstNonEmpty(row.websites),
    socials: row.socials ?? undefined,
    brand,
    names: localized.variants,
    osmTags: Object.keys(osmTags).length > 0 ? osmTags : undefined,
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
  ): Promise<PoiSearchResult[]> {
    const concepts = openMapXCategoryToOvertureConcepts(category);
    if (!concepts.length) return [];
    if (!boundDb) return [];
    const rows = await queryOverturePlaces(boundDb, {
      bbox,
      concepts,
      lang: _options?.lang,
      // Calibrated to 0.5 (was 0.7): the sweep showed 0.7 excludes most genuine
      // places; matches the offline conflation candidate floor.
      minConfidence: 0.5,
    });
    return rows.map((row) =>
      overtureRowToPoiSearchResult(row, category as CategoryId, _options?.lang),
    );
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
      await db.execute("SELECT 1 FROM overture_places.places LIMIT 1");
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
