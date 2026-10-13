import type { PlaceAddressComponents } from "../types/address";
import type { Place } from "../types/place";

const COMPONENT_KEYS = [
  "house_number",
  "house",
  "road",
  "place",
  "full",
  "city",
  "town",
  "village",
  "municipality",
  "county",
  "state",
  "postcode",
  "country",
  "country_code",
] as const;

/** Keep only known string components; POI names and hierarchy keys are not address parts. */
export function sanitizeAddressComponents(value: unknown): PlaceAddressComponents {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const components: PlaceAddressComponents = {};
  for (const key of COMPONENT_KEYS) {
    const part = (value as Record<string, unknown>)[key];
    if (typeof part === "string" && part.trim())
      components[key] = key === "country_code" ? part.trim().toLowerCase() : part.trim();
  }
  return components;
}

export function addressComponentsFromOsmTags(
  tags: Record<string, unknown>,
): PlaceAddressComponents {
  return sanitizeAddressComponents({
    house_number: tags["addr:housenumber"],
    house: tags["addr:housename"],
    road: tags["addr:street"],
    place: tags["addr:place"],
    full: tags["addr:full"],
    postcode: tags["addr:postcode"],
    city: tags["addr:city"],
    town: tags["addr:town"],
    state: tags["addr:state"],
    country_code: tags["addr:country"],
  });
}

/** A locality or marker label does not establish a premises address. */
export function hasUsablePlaceAddress(
  place: Pick<Place, "address" | "name" | "addressEvidence">,
): boolean {
  if (!place.address?.trim()) return false;
  const evidence = place.addressEvidence;
  // Keep existing provider-owned address behavior for persisted legacy Places.
  if (!evidence) return place.address !== place.name;
  if (evidence.method === "provider-label" || evidence.method === "reverse") return false;
  const c = sanitizeAddressComponents(evidence.components);
  return Boolean(c.full || c.house || (c.house_number && (c.road || c.place)));
}

function hasOwnOsmAddress(place: Place): boolean {
  const c = sanitizeAddressComponents(place.addressEvidence?.components);
  return (
    place.addressEvidence?.method === "osm-tags" &&
    Boolean(place.ids.osm) &&
    place.addressEvidence.recordId === `osm:${place.ids.osm}` &&
    Boolean(place.address?.trim() && (c.full || c.house || c.road || c.place || c.house_number))
  );
}

/** Choose a whole candidate, retaining conservative legacy precedence for unknown evidence. */
export function selectPlaceAddress(
  selected: Place,
  resolved: Place | null | undefined,
  isDataSourcePlace: boolean,
): Place {
  if (!resolved?.address) return selected;
  if (haveConflictingOsmIds(selected, resolved)) return selected;
  if (isDataSourcePlace && hasUsablePlaceAddress(selected)) return selected;
  if (hasOwnOsmAddress(selected) && !hasOwnOsmAddress(resolved)) return selected;
  return resolved;
}

export function haveConflictingOsmIds(
  selected: Place | null,
  resolved: Place | null | undefined,
): boolean {
  return Boolean(selected?.ids.osm && resolved?.ids.osm && selected.ids.osm !== resolved.ids.osm);
}

export function isMovingDataSourcePlace(place: Place): boolean {
  return Boolean(
    place.ids[place.primaryScheme]?.startsWith("v:") || place.dataSourceDetail?.id.startsWith("v:"),
  );
}

/** Known locality-only components are context, while an unparsed label remains unknown. */
export function isLocalityOnlyAddress(place: Pick<Place, "addressEvidence">): boolean {
  const evidence = place.addressEvidence;
  if (!evidence || evidence.method === "provider-label") return false;
  const c = sanitizeAddressComponents(evidence.components);
  return Object.keys(c).length > 0 && !(c.full || c.house || c.road || c.place || c.house_number);
}

/** Only the selected MapTiler feature's direct root reference may change lookup dispatch. */
export function directPlaceDetailsId(place: Place, isDataSourcePlace: boolean): string | null {
  if (place.primaryScheme === "coordinate") return null;
  const ref = place.directOsmReference;
  if (
    !isDataSourcePlace &&
    place.primaryScheme === "maptiler" &&
    ref?.source === "geocoding-maptiler" &&
    ref.recordId === place.id &&
    /^(node|way|relation)\/[1-9]\d*$/.test(ref.osmRef) &&
    place.ids.osm === ref.osmRef
  ) {
    return `osm:${ref.osmRef}`;
  }
  return place.id;
}
