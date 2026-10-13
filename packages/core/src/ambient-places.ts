import { type Attribution, OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
import {
  contributorsForRecordFields,
  contributorsForRecords,
  type FieldContributors,
  parseContributors,
  readCapturedContributors,
  readCapturedFieldContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { CategoryPlace } from "./types/category";
import type { Place } from "./types/place";
import { haversineDistance } from "./utils/coordinates";
import { overtureTaxonomyCategoryEvidence } from "./utils/overtureCategoryMap";
import { captureOvertureFieldContributors, type OvertureSourceItem } from "./utils/overtureSource";

export const AMBIENT_POLICY_VERSION = 2;
export const AMBIENT_FORMAT_VERSION = 2;
/** Honest aggregate receipt for pre-capture Overture snapshots. */
export const AMBIENT_LEGACY_OVERTURE_ATTRIBUTION: Readonly<Attribution> = Object.freeze({
  sourceId: "overture",
  name: "Overture Maps",
  url: "https://overturemaps.org",
  licensing: {
    version: 1,
    bindings: [
      {
        scope: "data",
        subject: "Data",
        license: {
          kind: "spdx",
          expression: "CDLA-Permissive-2.0",
          url: "https://cdla.dev/permissive-2-0/",
        },
      },
    ],
  } as const,
});
export const AMBIENT_MAX_AGE_MS = 90 * 86400_000;
export const AMBIENT_LIMITS = {
  places: 100_000,
  countryPlaces: 20_000_000,
  countryBatch: 2_000,
  generations: 8,
  tileFeatures: 256,
  tileBytes: 128 * 1024,
  minZoom: 13,
  maxZoom: 18,
  cacheSeconds: 7 * 86400,
} as const;
export interface AmbientRegion {
  name: string;
  bounds: [number, number, number, number];
  coverage?: "germany" | "planet";
}
export const AMBIENT_GERMANY_REGION: AmbientRegion = {
  name: "Germany",
  bounds: [5.8, 47.2, 15.1, 55.1],
  coverage: "germany",
};
export const AMBIENT_PLANET_REGION: AmbientRegion = {
  name: "Planet",
  bounds: [-180, -85.051129, 180, 85.051129],
  coverage: "planet",
};
export interface AmbientPlace {
  id: string;
  gersId?: string;
  name: string;
  names: Record<string, string>;
  coordinates: [number, number];
  category: string;
  rank: number;
  minZoom: number;
  tenant: boolean;
  sources: "osm" | "overture" | "osm,overture";
  contributors?: Attribution[];
  fieldContributors?: FieldContributors;
  sourceLineage?: { sources: readonly OvertureSourceItem[]; release?: string };
  /** Build-time precision diagnostic; raw lineage alone cannot prove notices. */
  legacyAttribution?: boolean;
}
export interface AmbientManifest {
  version: 1 | 2;
  attributionPrecision?: "captured-fields" | "legacy-aggregate";
  policyVersion: number;
  generation: string;
  publishedAt: string;
  region: AmbientRegion;
  placeCount: number;
  enabled: boolean;
  sources: {
    osm: { region: string; epoch: string; publishedAt: string; count: number };
    overture: { region: string; release: string; publishedAt: string; count: number } | null;
  };
}
export interface AmbientBuildProgress {
  phase: "osm" | "overture" | "validate";
  processed: number;
  batches: number;
  placeCount: number;
}
/** Operator-only durable global candidate; never included in public discovery. */
export interface AmbientPlanetCandidate {
  generation: string;
  status: "running" | "failed" | "completed";
  checkpoint: AmbientBuildProgress;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}
export const AMBIENT_GENERATION_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
export interface AmbientOsmRow {
  osm_type: string;
  osm_id: string;
  name: string;
  lng: number;
  lat: number;
  category: string | null;
  importance: number;
  tags: Record<string, string>;
}
export interface AmbientOvertureRow {
  gers_id: string;
  name: string;
  longitude: number;
  latitude: number;
  basic_category: string | null;
  taxonomy_primary?: string | null;
  taxonomy_hierarchy?: string[] | null;
  taxonomy_alternates?: string[] | null;
  names?: { common?: Record<string, string> | null } | null;
  confidence: number | null;
  operating_status: string | null;
  sources?: OvertureSourceItem[] | null;
  sources_catalogue?: Attribution[] | null;
  release?: string;
}
export function validateAmbientRegion(value: unknown): AmbientRegion {
  const region = value as AmbientRegion;
  const b = region?.bounds;
  const preset =
    region?.coverage === "germany"
      ? AMBIENT_GERMANY_REGION
      : region?.coverage === "planet"
        ? AMBIENT_PLANET_REGION
        : null;
  if (
    typeof region?.name !== "string" ||
    !region.name.trim() ||
    region.name.length > 80 ||
    !Array.isArray(b) ||
    b.length !== 4 ||
    !b.every(Number.isFinite) ||
    b[0] < -180 ||
    b[2] > 180 ||
    b[1] < -85.051129 ||
    b[3] > 85.051129 ||
    b[2] <= b[0] ||
    b[3] <= b[1] ||
    (region.coverage !== undefined && !preset) ||
    (preset ? !b.every((v, i) => v === preset.bounds[i]) : b[2] - b[0] > 0.5 || b[3] - b[1] > 0.5)
  )
    throw new Error(
      "Choose the exact Germany/planet preset or an ordered world region no wider or higher than 0.5 degrees",
    );
  return {
    name: region.name.trim(),
    bounds: [...b],
    ...(preset ? { coverage: preset.coverage } : {}),
  };
}

const aliases: Record<string, string> = {
  hospitals: "hospital",
  doctors: "doctor",
  pharmacies: "pharmacy",
  restaurants: "restaurant",
  cafes: "cafe",
  banks: "bank",
  hotels: "hotel",
  supermarkets: "supermarket",
  bakeries: "bakery",
  museums: "museum",
  coffee_shop: "cafe",
  railway_station: "station",
  townhall: "townhall",
};
export function ambientCategory(value: string): string {
  const raw = value.split(/[:/]/).at(-1)!;
  return aliases[raw] ?? raw;
}
const essential = new Set([
  "hospital",
  "doctor",
  "pharmacy",
  "station",
  "aerodrome",
  "townhall",
  "library",
  "police",
  "fire_station",
]);
const everyday = new Set([
  "restaurant",
  "cafe",
  "bank",
  "hotel",
  "supermarket",
  "bakery",
  "fuel",
  "gas_station",
  "shop",
  "dentist",
  "post_office",
]);
function label(value: unknown): string {
  return typeof value === "string" ? [...value.trim()].slice(0, 120).join("") : "";
}
function point(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 85.051129
  );
}
const culturalDestinations = new Set([
  "place_of_worship",
  "museum",
  "gallery",
  "castle",
  "monument",
  "archaeological_site",
  "attraction",
]);
function landmarkZoom(category: string, tags: Record<string, string>): 14 | 15 | null {
  if (!culturalDestinations.has(ambientCategory(category))) return null;
  const identified =
    /^Q[1-9]\d*$/.test(tags.wikidata ?? "") ||
    /^[a-z]{2,3}(?:-[a-z]+)?:\S/.test(tags.wikipedia ?? "");
  if (!identified) return null;
  const heritage = /^(?:[1-9]|10|yes)$/.test(tags.heritage ?? "");
  const designated =
    tags.building === "cathedral" ||
    tags["church:type"] === "cathedral" ||
    ["yes", "minor", "major"].includes(tags.basilica);
  if (!heritage && !designated) return null;
  return designated || /^[1-3]$/.test(tags.heritage ?? "") ? 14 : 15;
}
function policy(
  category: string,
  importance: number,
  tenant: boolean,
  landmark: 14 | 15 | null = null,
) {
  const c = ambientCategory(category);
  const tier = essential.has(c)
    ? 3
    : landmark
      ? 2.5
      : everyday.has(c) || /^shop[:/]/.test(category)
        ? 2
        : 1;
  return {
    rank:
      tier * 1000 +
      Math.round(Math.max(0, Math.min(1, Number.isFinite(importance) ? importance : 0)) * 99),
    minZoom: tenant ? 18 : tier === 3 ? 13 : (landmark ?? (tier === 2 ? 15 : 16)),
  };
}
export function ambientPlaceFromOsm(row: AmbientOsmRow): AmbientPlace | null {
  let rawTags: unknown = row.tags ?? {};
  if (typeof rawTags === "string") {
    try {
      rawTags = JSON.parse(rawTags);
    } catch {
      return null;
    }
  }
  if (
    !rawTags ||
    typeof rawTags !== "object" ||
    Array.isArray(rawTags) ||
    !Object.values(rawTags).every((value) => typeof value === "string")
  )
    return null;
  const tags = rawTags as Record<string, string>;
  const name = label(row.name);
  if (
    !name ||
    !row.category?.trim() ||
    !point(row.lng, row.lat) ||
    !/^(node|way|relation)$/.test(row.osm_type) ||
    !/^\d+$/.test(row.osm_id) ||
    tags.access === "private" ||
    ["disused", "abandoned", "demolished", "removed", "closed"].some(
      (k) => tags[k] === "yes" || Object.keys(tags).some((t) => t.startsWith(`${k}:`)),
    )
  )
    return null;
  const category = row.category ?? "place";
  const landmark = landmarkZoom(category, tags);
  // An explicitly mapped whole cultural building is a destination, not an
  // interior tenant. Its level is not a promise about ground-floor entrances.
  const wholeBuilding =
    landmark !== null &&
    row.osm_type !== "node" &&
    ["cathedral", "church", "castle", "museum"].includes(tags.building) &&
    !tags.indoor &&
    !tags["building:part"];
  const tenant =
    !wholeBuilding &&
    [tags.level, tags.floor].some((v) => v !== undefined && v !== "0" && v !== "0.0");
  const names: Record<string, string> = {};
  for (const lang of ["de", "en"]) {
    const v = label(tags[`name:${lang}`]);
    if (v) names[lang] = v;
  }
  return {
    id: `osm:${row.osm_type}/${row.osm_id}`,
    name,
    names,
    coordinates: [row.lng, row.lat],
    category: ambientCategory(category),
    ...policy(category, row.importance, tenant, landmark),
    tenant,
    sources: "osm",
    contributors: snapshotContributors([OPENSTREETMAP_ATTRIBUTION]),
    fieldContributors: Object.fromEntries(
      [
        "name",
        ...Object.keys(names).map((lang) => `names.${lang}`),
        "coordinates",
        "category",
        "id",
      ].map((field) => [field, snapshotContributors([OPENSTREETMAP_ATTRIBUTION])]),
    ),
  };
}
export function ambientPlaceFromOverture(row: AmbientOvertureRow): AmbientPlace | null {
  const name = label(row.name);
  if (
    !name ||
    !row.gers_id ||
    !point(row.longitude, row.latitude) ||
    row.operating_status !== "open" ||
    row.confidence === null ||
    !Number.isFinite(row.confidence) ||
    row.confidence < 0.5
  )
    return null;
  const names: Record<string, string> = {};
  for (const lang of ["de", "en"]) {
    const v = label(row.names?.common?.[lang]);
    if (v) names[lang] = v;
  }
  const categoryEvidence = overtureTaxonomyCategoryEvidence({
    basicCategory: row.basic_category,
    primary: row.taxonomy_primary,
    hierarchy: row.taxonomy_hierarchy,
    alternates: row.taxonomy_alternates,
  });
  const category = ambientCategory(categoryEvidence.category ?? row.basic_category ?? "place");
  const place: AmbientPlace = {
    id: `overture:${row.gers_id}`,
    gersId: row.gers_id,
    name,
    names,
    coordinates: [row.longitude, row.latitude],
    category,
    ...policy(category, 0, false),
    tenant: false,
    sources: "overture",
  };
  const catalogue = parseContributors(row.sources_catalogue);
  const sourceLineage = { sources: structuredClone(row.sources ?? []), release: row.release };
  if (catalogue === undefined)
    return {
      ...place,
      contributors: snapshotContributors([AMBIENT_LEGACY_OVERTURE_ATTRIBUTION]),
      sourceLineage,
      legacyAttribution: true,
    };
  const captured = captureOvertureFieldContributors(place, row.sources, catalogue, {
    name: ["/names/primary"],
    ...Object.fromEntries(
      Object.keys(names).map((lang) => [`names.${lang}`, [`/names/common/${lang}`]]),
    ),
    coordinates: ["/geometry"],
    category: categoryEvidence.category
      ? categoryEvidence.propertyPointers
      : row.basic_category
        ? ["/basic_category"]
        : [],
  });
  captured.fieldContributors.gersId = snapshotContributors(
    catalogue.filter((r) => r.sourceId === "overture"),
  );
  captured.contributors = contributorsForRecords(
    Object.values(captured.fieldContributors).map((contributors) => ({ contributors })),
  );
  return { ...captured, sourceLineage };
}
export function mergeAmbientPlaces(
  osm: AmbientPlace[],
  overture: AmbientPlace[],
  links: Map<string, string>,
  excludedOsm: ReadonlySet<string> = new Set(),
  identityEvidence: ReadonlyMap<string, AmbientOvertureIdentityEvidence> = new Map(),
): AmbientPlace[] {
  const byGers = new Map(overture.map((p) => [p.gersId, p]));
  const consumed = new Set<string>();
  const result = osm.map((p) => {
    const gersId = links.get(p.id);
    if (!gersId) return p;
    consumed.add(gersId);
    const o = byGers.get(gersId);
    const identity = o ?? identityEvidence.get(gersId);
    const fieldContributors =
      p.fieldContributors === undefined && o?.fieldContributors === undefined
        ? undefined
        : {
            ...p.fieldContributors,
            ...Object.fromEntries(
              Object.keys(o?.names ?? {})
                .filter((lang) => !p.names[lang])
                .map((lang) => [
                  `names.${lang}`,
                  o?.fieldContributors?.[`names.${lang}`] ?? o?.contributors ?? [],
                ]),
            ),
            gersId: identity?.fieldContributors?.gersId ?? [AMBIENT_LEGACY_OVERTURE_ATTRIBUTION],
          };
    return {
      ...p,
      gersId,
      names: { ...o?.names, ...p.names },
      sources: o ? ("osm,overture" as const) : ("osm" as const),
      fieldContributors,
      contributors: fieldContributors
        ? contributorsForRecords(
            Object.values(fieldContributors).map((contributors) => ({ contributors })),
          )
        : snapshotContributors(
            p.contributors ?? [],
            identity?.fieldContributors?.gersId ?? [AMBIENT_LEGACY_OVERTURE_ATTRIBUTION],
          ),
      sourceLineage: identity?.sourceLineage,
      legacyAttribution: identity?.legacyAttribution ?? !identity,
    };
  });
  const canonicalByGers = new Map([...links].map(([id, gers]) => [gers, id]));
  for (const p of overture) {
    if (!p.gersId || consumed.has(p.gersId)) continue;
    const canonicalId = canonicalByGers.get(p.gersId);
    if (canonicalId && excludedOsm.has(canonicalId)) continue;
    result.push(canonicalId ? { ...p, id: canonicalId } : p);
  }
  return result.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id, "en"));
}
export type AmbientOvertureIdentityEvidence = Pick<
  AmbientPlace,
  "fieldContributors" | "sourceLineage" | "legacyAttribution"
>;
/** Accepted GERS identity does not depend on eligibility of display fields. */
export function ambientOvertureIdentityEvidence(
  row: Pick<AmbientOvertureRow, "sources" | "sources_catalogue" | "release">,
): AmbientOvertureIdentityEvidence {
  const catalogue = parseContributors(row.sources_catalogue);
  return {
    fieldContributors: {
      gersId: snapshotContributors(
        catalogue === undefined
          ? [AMBIENT_LEGACY_OVERTURE_ATTRIBUTION]
          : catalogue.filter((receipt) => receipt.sourceId === "overture"),
      ),
    },
    sourceLineage: { sources: structuredClone(row.sources ?? []), release: row.release },
    legacyAttribution: catalogue === undefined,
  };
}
export function ambientPlaceToCategoryPlace(place: AmbientPlace, locale: string): CategoryPlace {
  return {
    id: place.id,
    gersId: place.gersId,
    name: place.names[locale.split("-")[0]] || place.name,
    names: place.names,
    coordinates: place.coordinates,
    category: place.category,
    contributors: ambientPlaceContributors(place, locale),
    fieldContributors:
      place.fieldContributors === undefined
        ? undefined
        : {
            ...place.fieldContributors,
            name:
              place.fieldContributors[
                place.names[locale.split("-")[0]] ? `names.${locale.split("-")[0]}` : "name"
              ] ?? [],
          },
  };
}
/** Fields represented by the placed label, position, category and identity. */
export function ambientPlaceContributors(place: AmbientPlace, locale: string): Attribution[] {
  if (place.contributors !== undefined || place.fieldContributors !== undefined)
    return contributorsForRecordFields(place, [
      place.names[locale.split("-")[0]] ? `names.${locale.split("-")[0]}` : "name",
      "coordinates",
      "category",
      "id",
      "gersId",
    ]);
  return snapshotContributors(
    ...(place.sources.includes("osm") ? [[OPENSTREETMAP_ATTRIBUTION]] : []),
    ...(place.sources.includes("overture") ? [[AMBIENT_LEGACY_OVERTURE_ATTRIBUTION]] : []),
  );
}
/** A v2 container may still carry honestly identified legacy source records. */
export function ambientHasLegacyAttribution(places: readonly AmbientPlace[]): boolean {
  return places.some(
    (place) =>
      place.legacyAttribution || (Boolean(place.gersId) && place.sourceLineage === undefined),
  );
}
export function ambientIdentityKeys(
  place: Pick<Place, "id" | "ids"> | Pick<CategoryPlace, "id" | "gersId">,
): string[] {
  const ids = "ids" in place ? place.ids : undefined;
  const gers = "gersId" in place ? place.gersId : (ids?.overture ?? ids?.gers);
  return [place.id, ...(gers ? [`overture:${gers}`] : []), ...(ids?.osm ? [`osm:${ids.osm}`] : [])];
}
export interface AmbientBasemapLabel {
  key: string;
  name: string;
  coordinates: [number, number];
  category?: string;
  osmId?: string;
}
export function matchAmbientBasemap(
  places: AmbientPlace[],
  labels: AmbientBasemapLabel[],
): Map<string, AmbientPlace> {
  const matches = new Map<string, AmbientPlace>();
  const normalize = (s: string) => s.trim().normalize("NFKC").toLocaleLowerCase("de");
  const byName = new Map<string, AmbientPlace[]>();
  const byId = new Map(places.map((p) => [p.id, p]));
  for (const p of places)
    if (!p.tenant)
      for (const name of new Set([p.name, ...Object.values(p.names)].map(normalize))) {
        const bucket = byName.get(name) ?? [];
        bucket.push(p);
        byName.set(name, bucket);
      }
  for (const l of labels) {
    if (l.osmId) {
      const exact = byId.get(l.osmId);
      if (exact) matches.set(l.key, exact);
      continue;
    }
    const candidates = (byName.get(normalize(l.name)) ?? []).filter(
      (p) =>
        l.category &&
        ambientCategory(l.category) === p.category &&
        // OSM outlines and vector-tile points can use slightly different representatives.
        haversineDistance(p.coordinates, l.coordinates) <= 10,
    );
    if (candidates.length === 1) matches.set(l.key, candidates[0]);
  }
  return matches;
}
/** Only schema-versioned, public properties are read from a vector feature. */
export function ambientPlaceFromTile(
  properties: Record<string, unknown>,
  coordinates: number[],
): AmbientPlace | null {
  // MapLibre projects buffered seam features into the neighbouring world copy.
  // Normalize at this decoding boundary; source ingestion keeps strict bounds.
  let longitude = coordinates[0];
  if (Number.isFinite(longitude) && (longitude < -180 || longitude > 180))
    longitude = ((((longitude + 180) % 360) + 360) % 360) - 180;
  if (
    typeof properties.id !== "string" ||
    !/^(osm:(node|way|relation)\/\d+|overture:.+)$/.test(properties.id) ||
    typeof properties.name !== "string" ||
    !point(longitude, coordinates[1])
  )
    return null;
  return {
    id: properties.id,
    gersId:
      typeof properties.gers_id === "string" && properties.gers_id ? properties.gers_id : undefined,
    name: properties.name,
    names: {
      ...(properties.name_de ? { de: String(properties.name_de) } : {}),
      ...(properties.name_en ? { en: String(properties.name_en) } : {}),
    },
    coordinates: [longitude, coordinates[1]],
    category: String(properties.category ?? "place"),
    rank: Number(properties.rank),
    minZoom: Number(properties.min_zoom),
    tenant: properties.tenant === true || properties.tenant === 1,
    sources:
      properties.sources === "osm,overture"
        ? "osm,overture"
        : properties.sources === "overture"
          ? "overture"
          : "osm",
    ...(Number(properties.format_version) === AMBIENT_FORMAT_VERSION
      ? {
          contributors: readCapturedContributors(properties._mapAttributions) ?? [],
          fieldContributors: readCapturedFieldContributors(properties.field_contributors),
          sourceLineage: parseAmbientSourceLineage(properties.source_lineage),
        }
      : {}),
  };
}
function parseAmbientSourceLineage(value: unknown): AmbientPlace["sourceLineage"] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { sources?: unknown }).sources)
  )
    return undefined;
  return structuredClone(value) as AmbientPlace["sourceLineage"];
}
