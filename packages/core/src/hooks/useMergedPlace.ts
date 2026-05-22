import type { ReverseGeocodingResult } from "@integrations/geocoding/types";
import type { DataSourceDetail } from "@openmapx/integration-framework";
import { useDataSourceStore } from "../stores/dataSourceStore";
import type { Place } from "../types/place";
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
 *     Nominatim/Overpass details win when available, selectedPlace fills gaps.
 *  3. Reverse geocoding fills address/city only when both OSM lookup and
 *     selectedPlace have nothing.
 *  4. dataSourceDetail: from selectedPlace if present, otherwise from
 *     useDataSourceMatch.
 */
function mergePlaceFields(
  selected: Place,
  nominatim: Place | null | undefined,
  reverseGeo: ReverseGeocodingResult | null | undefined,
  matchedDetail: DataSourceDetail | null,
  isDataSourceItem: boolean,
): Place {
  const nom = nominatim ?? null;

  const isDataSourcePlace = isDataSourceItem || selected.dataSourceDetail !== undefined;

  const base: Place = nom
    ? {
        ...nom,
        // Identity fields: selected wins so `id`/`primaryScheme`/`ids`
        // stay coherent with what the client originally constructed —
        // Nominatim's linked refs get folded into the ids map instead
        // of rewriting the primary.
        id: selected.id,
        primaryScheme: selected.primaryScheme,
        ids: { ...(nom.ids ?? {}), ...selected.ids },
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

  if (nom) {
    // Data-source places (OCM, OSM-multisource, etc.) own their address,
    // phone, website, and opening hours — the data source curates them and
    // they shouldn't be overwritten by whatever Overpass happens to return
    // for a nearby OSM node. Use data-source values first, fall back to
    // OSM only to fill genuine gaps.
    if (isDataSourcePlace) {
      base.address = selected.address || nom.address;
      base.city = selected.city || nom.city;
      base.phone = selected.phone || nom.phone;
      base.website = selected.website || nom.website;
      base.openingHours = selected.openingHours || nom.openingHours;
    } else {
      base.address = nom.address || selected.address;
      base.city = nom.city || selected.city;
      base.phone = nom.phone || selected.phone;
      base.website = nom.website || selected.website;
      base.openingHours = nom.openingHours || selected.openingHours;
    }
  } else {
    if (!base.address && reverseGeo?.address) {
      base.address = reverseGeo.address;
    }
    if (!base.city && reverseGeo?.city) {
      base.city = reverseGeo.city.split(",")[0].trim();
    }
  }

  if (!base.address && reverseGeo?.address) {
    base.address = reverseGeo.address;
  }
  if (!base.city && reverseGeo?.city) {
    base.city = reverseGeo.city.split(",")[0].trim();
  }

  if (selected.dataSourceDetail) {
    base.dataSourceDetail = selected.dataSourceDetail;
    if (selected.openingHours) {
      base.openingHours = selected.openingHours;
    }
  } else if (matchedDetail) {
    base.dataSourceDetail = matchedDetail;
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
  const isCoordinatePlace = selectedPlace?.primaryScheme === "coordinate";

  // A place is a data-source place when the selection store's sourceId is
  // keyed into its ids map, or when the Place already carries a resolved
  // `dataSourceDetail` (arrives from DataSourceDetailBridge).
  const selectedItem = useDataSourceStore((s) => s.selectedItem);
  const isDataSourcePlace =
    selectedPlace?.dataSourceDetail !== undefined ||
    (selectedItem !== null && selectedPlace?.ids?.[selectedItem.sourceId] === selectedItem.itemId);

  // Skip the backend lookup for pure-coordinate places (synthetic id, no
  // resolver) — reverse-geocoding covers them. For everything else,
  // /api/places/:id dispatches to the registered scheme resolver, which
  // reads any osmFilters from the provider's manifest itself.
  const placeDetailsId = isCoordinatePlace ? null : (selectedPlace?.id ?? null);

  const { data: nominatimDetails, isLoading: nominatimLoading } = usePlaceDetails(
    placeDetailsId,
    selectedPlace?.coordinates,
    selectedPlace?.name,
    undefined,
    // Skip the server's Nominatim/Overpass address fallback when the client
    // already has one (data-source bridges populate address from the provider).
    Boolean(selectedPlace?.address),
  );

  const needsReverseGeo = isCoordinatePlace || isDataSourcePlace;
  const { data: reverseGeo } = useReverseGeocoding(
    needsReverseGeo ? (selectedPlace?.coordinates ?? null) : null,
  );

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

  const place = mergePlaceFields(
    selectedPlace,
    nominatimDetails,
    reverseGeo,
    matchedDetail,
    isDataSourcePlace,
  );

  return { place, isLoading: nominatimLoading && !nominatimDetails };
}
