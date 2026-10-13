import type {
  KnowledgeContext,
  KnowledgeProvider,
  KnowledgeResult,
  OvertureSourceItem,
} from "@openmapx/core";
import {
  CATEGORY_FILTERS,
  captureOvertureFieldContributors,
  nameSimilarity,
  normalizeOvertureProvenance,
  openMapXCategoryToOvertureConcepts,
} from "@openmapx/core";
import { AMBIENT_LEGACY_OVERTURE_ATTRIBUTION } from "@openmapx/core/ambient-places";
import type { DatabaseClient, IntegrationContext } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForRecords,
  parseContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";

let db: DatabaseClient | undefined;

export function bindDb(
  database: DatabaseClient,
  _ctx?: Pick<IntegrationContext, "manifest" | "attributionIndex">,
): void {
  db = database;
}

interface SpatialRow {
  gers_id: string;
  name: string;
}

interface OvertureDetailRow {
  gers_id: string;
  name: string;
  names: { primary?: string; common?: Record<string, string> | null } | null;
  // Overture nests the brand name under brand.names.primary (NOT brand.name);
  // wikidata is a sibling. Type it the way the data actually arrives.
  brand: { names?: { primary?: string } | null; wikidata?: string } | null;
  phones: string[] | null;
  websites: string[] | null;
  socials: string[] | null;
  emails: string[] | null;
  addresses: Array<{
    freeform?: string | null;
    locality?: string | null;
    postcode?: string | null;
    country?: string | null;
  }> | null;
  sources: OvertureSourceItem[] | null;
  sources_catalogue?: Attribution[] | null;
  release: string;
}

/**
 * Race a promise against a timeout returning null.
 * The orchestrator uses Promise.allSettled, not a race, so each source must
 * bound its own latency.
 */
async function withDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse an OSM ref like "node/123456789" into { type, id } or null.
 */
function parseOsmRef(ref: string): { type: string; id: bigint } | null {
  const match = /^(node|way|relation)\/(\d+)$/.exec(ref);
  if (!match) return null;
  return { type: match[1], id: BigInt(match[2]) };
}

/**
 * Resolve a GERS id for the given place.
 *
 * Phase 1 — link-first: query poi_conflation_link using the OSM ref from
 * context.ids.osm.
 *
 * Phase 2 — spatial+name: find candidates within 150 m of the place
 * coordinates and filter with Overture's own taxonomy hierarchy; pick the one whose name
 * achieves nameSimilarity >= 0.8 with the place name (normalized fuzzy match).
 *
 * context.ids may be undefined (the neighborhoods call site passes a partial
 * Place with no ids) — falls through to the spatial path without throwing.
 */
export async function resolveGers(
  database: DatabaseClient,
  osmTags: Record<string, string>,
  context: KnowledgeContext | undefined,
): Promise<string | null> {
  // Overture-produced places and already-enriched OSM places carry a stable
  // identifier. Trust that identity and let the detail lookup below validate
  // that the row still exists before considering any fuzzy matching.
  const directGers = context?.ids?.overture ?? context?.ids?.gers;
  if (directGers) return directGers;

  const osmRef = context?.ids?.osm;
  if (osmRef) {
    const parsed = parseOsmRef(osmRef);
    if (parsed) {
      const linkRows = await database.execute<SpatialRow[]>(
        `SELECT gers_id FROM overture_places.poi_conflation_link WHERE osm_type=$1 AND osm_id=$2 LIMIT 1`,
        [parsed.type, parsed.id],
      );
      if (Array.isArray(linkRows) && linkRows.length > 0) {
        return linkRows[0].gers_id;
      }
    }
  }

  const coords = context?.coordinates;
  const placeName = context?.name;
  if (!coords || !placeName) return null;

  const [lng, lat] = coords;
  const explicitCategory = osmTags.openmapx_category ?? osmTags.category;
  const category =
    explicitCategory && openMapXCategoryToOvertureConcepts(explicitCategory).length > 0
      ? explicitCategory
      : Object.entries(CATEGORY_FILTERS)
          .reverse()
          .find(([, filters]) =>
            filters.some((filter) => osmTags[filter.key] === filter.value),
          )?.[0];

  let sql: string;
  let params: unknown[];
  const concepts = category ? openMapXCategoryToOvertureConcepts(category) : [];
  if (concepts.length > 0) {
    sql = `
      SELECT gers_id, name
      FROM overture_places.places
      WHERE geom && ST_Envelope(
        ST_Buffer(
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          150
        )::geometry
      )
        AND ST_DWithin(
          geom::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          150
        )
        AND (
          basic_category = ANY($3::TEXT[])
          OR taxonomy_primary = ANY($3::TEXT[])
          OR taxonomy_hierarchy && $3::TEXT[]
          OR taxonomy_alternates && $3::TEXT[]
        )
        AND (operating_status IS NULL OR operating_status <> 'permanently_closed')
      ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
      LIMIT 5
    `;
    params = [lng, lat, concepts];
  } else {
    sql = `
      SELECT gers_id, name
      FROM overture_places.places
      WHERE geom && ST_Envelope(
        ST_Buffer(
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          150
        )::geometry
      )
        AND ST_DWithin(
          geom::geography,
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          150
        )
        AND (operating_status IS NULL OR operating_status <> 'permanently_closed')
      ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
      LIMIT 5
    `;
    params = [lng, lat];
  }

  const rows = await database.execute<SpatialRow[]>(sql, params);
  if (!Array.isArray(rows) || rows.length === 0) return null;

  for (const row of rows) {
    if (nameSimilarity(row.name, placeName) >= 0.8) {
      return row.gers_id;
    }
  }

  return null;
}

async function fetchOverturePlaceByGers(
  database: DatabaseClient,
  gersId: string,
): Promise<OvertureDetailRow | null> {
  const rows = await database.execute<OvertureDetailRow[]>(
    `
    SELECT gers_id, name, names, brand, phones, websites, socials, emails, addresses,
           sources, to_jsonb(places)->'sources_catalogue' AS sources_catalogue, release
    FROM overture_places.places
    WHERE gers_id = $1
    LIMIT 1
    `,
    [gersId],
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

function overtureRowToKnowledgeResult(row: OvertureDetailRow): KnowledgeResult | null {
  const catalogue = parseContributors(row.sources_catalogue) ?? [
    AMBIENT_LEGACY_OVERTURE_ATTRIBUTION,
  ];
  // A successful match always credits Overture as a source via its GERS id,
  // which surfaces as an "Overture Maps" external reference on the place card.
  const result: KnowledgeResult = {
    externalIds: { gers: row.gers_id },
    provenance: normalizeOvertureProvenance(row.sources, row.release),
  };

  const brandName = row.brand?.names?.primary;
  if (brandName) {
    result.brand = { name: brandName };
  }
  if (row.brand?.wikidata) {
    if (result.brand) result.brand.wikidata = row.brand.wikidata;
    result.externalIds = { ...result.externalIds, wikidata: row.brand.wikidata };
  }

  if (row.names?.common && Object.keys(row.names.common).length > 0) {
    result.names = row.names.common;
  }

  const phone = row.phones?.[0];
  if (phone) result.phone = phone;

  const website = row.websites?.[0];
  if (website) result.website = website;

  const email = row.emails?.[0];
  if (email) result.email = email;

  if (row.socials?.length) result.socials = row.socials;

  const address = row.addresses?.[0];
  if (address) {
    const localityLine = [address.postcode, address.locality].filter(Boolean).join(" ");
    result.address = [address.freeform, localityLine || undefined].filter(Boolean).join(", ");
    result.city = address.locality ?? undefined;
    result.countryCode = address.country?.toLowerCase() ?? undefined;
  }

  const pointers: Record<string, string[]> = {};
  for (const field of ["phone", "website", "email"] as const) {
    if (result[field])
      pointers[field] = [
        `/${field === "phone" ? "phones" : field === "email" ? "emails" : "websites"}/0`,
      ];
  }
  if (result.socials) pointers.socials = result.socials.map((_, index) => `/socials/${index}`);
  if (result.names) {
    pointers.names = [];
    for (const key of Object.keys(result.names)) {
      const pointer = `/names/common/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      pointers[`names.${key}`] = [pointer];
      pointers.names.push(pointer);
    }
  }
  if (result.brand) {
    pointers.brand = ["/brand/names/primary"];
    pointers["brand.name"] = ["/brand/names/primary"];
    if (result.brand.wikidata) {
      pointers.brand.push("/brand/wikidata");
      pointers["brand.wikidata"] = ["/brand/wikidata"];
    }
  }
  if (result.externalIds?.wikidata) pointers["externalIds.wikidata"] = ["/brand/wikidata"];
  if (result.address) {
    pointers.address = [];
    for (const field of ["freeform", "postcode", "locality"] as const)
      if (address?.[field]) pointers.address.push(`/addresses/0/${field}`);
  }
  if (result.city) pointers.city = ["/addresses/0/locality"];
  if (result.countryCode) pointers.countryCode = ["/addresses/0/country"];
  const captured = captureOvertureFieldContributors(result, row.sources, catalogue, pointers);
  captured.fieldContributors["externalIds.gers"] = snapshotContributors(
    catalogue.filter((receipt) => receipt.sourceId === "overture"),
  );
  captured.contributors = contributorsForRecords(
    Object.values(captured.fieldContributors).map((contributors) => ({ contributors })),
  );
  return captured;
}

export const overtureKnowledgeSource: KnowledgeProvider = {
  name: "knowledge-overture",

  async lookup(osmTags, _lang, context) {
    const database = db;
    if (!database) return null;

    return withDeadline(1500, async () => {
      const gers = await resolveGers(database, osmTags, context);
      if (!gers) return null;

      const row = await fetchOverturePlaceByGers(database, gers);
      return row ? overtureRowToKnowledgeResult(row) : null;
    });
  },
};
