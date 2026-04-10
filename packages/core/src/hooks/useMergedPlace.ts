import type { DataSourceDetail } from "../types/dataSource";
import type { Place } from "../types/place";
import type { ReverseGeocodingResult } from "../types/search";
import { useDataSourceMatch } from "./useDataSourceMatch";
import { usePlaceDetails } from "./usePlaceDetails";
import { useReverseGeocoding } from "./useReverseGeocoding";

/**
 * Prettifies a raw OSM category string for display.
 * "fuel" → "Fuel", "charging_station" → "Charging Station", "fast_food" → "Fast Food"
 */
function prettifyCategory(raw: string): string {
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Merges place data from all available sources into a single Place.
 *
 * Priority rules (per field):
 *  1. Identity fields (id, name, category, rawCategory, dataSourceDetail):
 *     selectedPlace always wins — these define what the user clicked.
 *  2. OSM-sourced fields (address, city, phone, website, openingHours, osmTags,
 *     description, wikipediaUrl, photos, facts, reviewLinks, rating, reviewCount):
 *     Nominatim details win when available, selectedPlace fills gaps.
 *  3. Reverse geocoding fills address/city only when both Nominatim and
 *     selectedPlace have nothing.
 *  4. dataSourceDetail: from selectedPlace if present, otherwise from
 *     useDataSourceMatch.
 */
function mergePlaceFields(
  selected: Place,
  nominatim: Place | null | undefined,
  reverseGeo: ReverseGeocodingResult | null | undefined,
  matchedDetail: DataSourceDetail | null,
): Place {
  const nom = nominatim ?? null;

  const isDataSourcePlace = selected.dataSourceDetail !== undefined;

  // Start with Nominatim as the rich base (if available), then overlay identity fields.
  // For data source places, the data source's own name/category always win because
  // Nominatim can resolve to the wrong OSM element (e.g. a house number instead of
  // the fuel station at that address).
  const base: Place = nom
    ? {
        ...nom,
        id: selected.id,
        name: isDataSourcePlace ? selected.name || nom.name : nom.name || selected.name,
        category: isDataSourcePlace
          ? prettifyCategory(selected.category ?? "") || nom.category
          : nom.category || prettifyCategory(selected.category ?? ""),
        rawCategory: selected.rawCategory || nom.rawCategory,
      }
    : {
        ...selected,
        category: selected.category ? prettifyCategory(selected.category) : selected.category,
      };

  // OSM-sourced fields: Nominatim wins, selectedPlace fills gaps
  if (nom) {
    base.address = nom.address || selected.address;
    base.city = nom.city || selected.city;
    base.phone = nom.phone || selected.phone;
    base.website = nom.website || selected.website;
    base.openingHours = nom.openingHours || selected.openingHours;
  } else {
    // No Nominatim — keep selectedPlace fields, fill address from reverse geocoding
    if (!base.address && reverseGeo?.address) {
      base.address = reverseGeo.address;
    }
    if (!base.city && reverseGeo?.city) {
      base.city = reverseGeo.city.split(",")[0].trim();
    }
  }

  // Reverse geocoding fills address/city gaps even when Nominatim is available
  // (Nominatim name+coord lookup can return a match without a full address)
  if (!base.address && reverseGeo?.address) {
    base.address = reverseGeo.address;
  }
  if (!base.city && reverseGeo?.city) {
    base.city = reverseGeo.city.split(",")[0].trim();
  }

  // Data source detail: from the selection if present, otherwise from matching
  if (selected.dataSourceDetail) {
    base.dataSourceDetail = selected.dataSourceDetail;
    // Data source openingHours (e.g. Tankerkoenig) wins over Nominatim if present
    if (selected.openingHours) {
      base.openingHours = selected.openingHours;
    }
  } else if (matchedDetail) {
    base.dataSourceDetail = matchedDetail;
    // Data source hours (e.g. Tankerkoenig) are more authoritative than Nominatim OSM tags
    if (matchedDetail.openingHours) {
      base.openingHours = matchedDetail.openingHours;
    }
  }

  return base;
}

/**
 * Unified hook that resolves a selected Place from all available sources
 * (Nominatim, reverse geocoding, data source APIs) and merges them with
 * deterministic priority.
 *
 * Used by both PlacePanelContent and PlaceDetailCard to guarantee
 * consistent data regardless of how the place was accessed.
 */
export function useMergedPlace(selectedPlace: Place | null): {
  place: Place | null;
  isLoading: boolean;
} {
  // Coordinate/Plus Code places have synthetic IDs that would 404 on Nominatim.
  // Skip the place details lookup for those — reverse geocoding handles them.
  const isCoordinatePlace = selectedPlace?.id?.startsWith("coordinate-") ?? false;

  // For data source places, use a synthetic key to force name+coord lookup
  // (their IDs like "tankerkoenig/uuid" are not OSM IDs).
  const isDataSourcePlace = selectedPlace?.dataSourceDetail !== undefined;
  const placeDetailsId = isCoordinatePlace
    ? null
    : isDataSourcePlace
      ? `ds-${selectedPlace?.id ?? ""}`
      : (selectedPlace?.id ?? null);

  // For Nominatim lookup, use the address as the search term for data source places
  // because data source names (e.g. "PM Rheinberg Rheinberger Str. 373" from Tankerkoenig)
  // often don't match OSM names (e.g. "Freie Tankstelle"), but addresses match reliably.
  const nominatimName = isDataSourcePlace
    ? selectedPlace?.address || selectedPlace?.name
    : selectedPlace?.name;

  // 1. Nominatim lookup (address, phone, website, openingHours, osmTags, etc.)
  const { data: nominatimDetails, isLoading: nominatimLoading } = usePlaceDetails(
    placeDetailsId,
    selectedPlace?.coordinates,
    nominatimName,
  );

  // 2. Reverse geocoding (address/city fallback — always runs for coordinates,
  //    also runs for data source places in case Nominatim name lookup fails)
  const needsReverseGeo = isCoordinatePlace || isDataSourcePlace;
  const { data: reverseGeo } = useReverseGeocoding(
    needsReverseGeo ? (selectedPlace?.coordinates ?? null) : null,
  );

  // 3. Data source matching (EV charging, fuel — only when not already present).
  // Build an intermediate place that includes Nominatim-resolved osmTags/category
  // so the matching hook can resolve the data source even when the original
  // selectedPlace has no category info (e.g. from a share link).
  const placeForMatch = (() => {
    if (!selectedPlace || selectedPlace.dataSourceDetail) return null;
    if (nominatimDetails?.osmTags || nominatimDetails?.rawCategory) {
      return {
        ...selectedPlace,
        osmTags: nominatimDetails.osmTags ?? selectedPlace.osmTags,
        rawCategory: selectedPlace.rawCategory || nominatimDetails.rawCategory,
        category: selectedPlace.category || nominatimDetails.category,
      };
    }
    return selectedPlace;
  })();
  const matchedDetail = useDataSourceMatch(placeForMatch);

  if (!selectedPlace) {
    return { place: null, isLoading: false };
  }

  const place = mergePlaceFields(selectedPlace, nominatimDetails, reverseGeo, matchedDetail);

  return { place, isLoading: nominatimLoading && !nominatimDetails };
}
