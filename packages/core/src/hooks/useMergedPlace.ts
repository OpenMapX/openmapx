import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  type ContributingRecord,
  captureFieldContributors,
  contributorsForField,
  contributorsForFields,
  contributorsForRecords,
  type FieldContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { useDataSourceStore } from "../stores/dataSourceStore";
import type { DataSourceDetail } from "../types/dataSource";
import type { ReverseGeocodingResult } from "../types/geocoding";
import type { Place } from "../types/place";
import { matchingOpeningHours } from "../utils/openingHoursClient";
import { useDataSourceMatch } from "./useDataSourceMatch";
import { useOpeningHoursClock } from "./useOpeningHoursClock";
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

  const fields: Record<string, Attribution[]> = {};
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

  // Snapshot ownership alongside each value winner. A present field map is
  // authoritative: a missing child never borrows the blended record receipt.
  const transfer = (
    field: string,
    owner: ContributingRecord & { fieldContributors?: FieldContributors },
    sourceField = field,
  ) => {
    for (const key of Object.keys(fields)) {
      if (key === field || key.startsWith(`${field}.`)) delete fields[key];
    }
    Object.assign(fields, captureFieldContributors(owner, sourceField, field));
  };
  for (const field of Object.keys(base)) {
    if (!["contributors", "fieldContributors", "ids"].includes(field))
      transfer(field, nom ?? selected);
  }
  for (const field of ["id", "primaryScheme"] as const) transfer(field, selected);
  transfer(
    "name",
    nom && (isDataSourcePlace ? !selected.name : Boolean(nom.name)) ? nom : selected,
  );
  transfer(
    "category",
    nom && (isDataSourcePlace ? !selected.category : Boolean(nom.category)) ? nom : selected,
  );
  transfer("rawCategory", selected.rawCategory ? selected : (nom ?? selected));
  for (const key of Object.keys(base.ids ?? {})) {
    transfer(`ids.${key}`, selected.ids?.[key] !== undefined ? selected : (nom ?? selected));
  }

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
    for (const field of ["address", "city", "phone", "website", "openingHours"] as const) {
      transfer(field, (isDataSourcePlace ? selected[field] : !nom[field]) ? selected : nom);
    }
  } else {
    if (!base.address && reverseGeo?.address) {
      base.address = reverseGeo.address;
      transfer("address", reverseGeo);
    }
    if (!base.city && reverseGeo?.city) {
      base.city = reverseGeo.city.split(",")[0].trim();
      transfer("city", reverseGeo);
    }
  }

  if (!base.address && reverseGeo?.address) {
    base.address = reverseGeo.address;
    transfer("address", reverseGeo);
  }
  if (!base.city && reverseGeo?.city) {
    base.city = reverseGeo.city.split(",")[0].trim();
    transfer("city", reverseGeo);
  }

  if (selected.dataSourceDetail) {
    base.dataSourceDetail = selected.dataSourceDetail;
    transfer("dataSourceDetail", selected);
    if (selected.openingHours) {
      base.openingHours = selected.openingHours;
      transfer("openingHours", selected);
    }
  } else if (matchedDetail) {
    base.dataSourceDetail = matchedDetail;
    transfer("dataSourceDetail", matchedDetail);
    for (const field of Object.keys(matchedDetail)) {
      if (!["contributors", "fieldContributors"].includes(field)) {
        Object.assign(
          fields,
          captureFieldContributors(matchedDetail, field, `dataSourceDetail.${field}`),
        );
      }
    }
    if (matchedDetail.openingHours) {
      base.openingHours = matchedDetail.openingHours;
      transfer("openingHours", matchedDetail);
    }
  }

  for (const key of Object.keys(fields)) {
    const root = key.split(".")[0];
    if ((base as unknown as Record<string, unknown>)[root] === undefined) delete fields[key];
  }
  base.fieldContributors = fields;
  base.contributors = snapshotContributors(
    contributorsForFields(fields, Object.keys(fields)),
    contributorsForRecords(base.photos ?? []),
    contributorsForRecords(base.facts ?? []),
  );
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
  const now = useOpeningHoursClock();
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

  // Keep the computed verdict with the exact raw schedule that won merging.
  // A matched data source may supply different hours without a computed status;
  // in that case show the schedule neutrally until its source can evaluate it.
  const matchingCandidates = [
    ...(isDataSourcePlace ? [selectedPlace, nominatimDetails] : [nominatimDetails, selectedPlace]),
  ];
  const chosenHours = matchingOpeningHours(place.openingHours, matchingCandidates, now);
  place.openingHoursInfo = chosenHours.info;
  place.openingHoursSource = chosenHours.source;
  const fields: Record<string, readonly Attribution[]> = { ...place.fieldContributors };
  for (const key of Object.keys(fields)) {
    if (
      ["openingHoursInfo", "openingHoursSource"].some(
        (field) => key === field || key.startsWith(`${field}.`),
      )
    )
      delete fields[key];
  }
  if (chosenHours.info) {
    const infoOwner = matchingCandidates.find(
      (candidate) =>
        candidate?.openingHours === place.openingHours &&
        candidate?.openingHoursInfo === chosenHours.info,
    );
    Object.assign(fields, infoOwner ? captureFieldContributors(infoOwner, "openingHoursInfo") : {});
    fields.openingHoursInfo = snapshotContributors(
      contributorsForField(place, "openingHours"),
      infoOwner ? contributorsForField(infoOwner, "openingHoursInfo") : [],
    );
  }
  const sourceOwner = matchingCandidates.find(
    (candidate) =>
      candidate?.openingHours === place.openingHours &&
      candidate?.openingHoursSource === chosenHours.source,
  );
  if (chosenHours.source && sourceOwner)
    Object.assign(fields, captureFieldContributors(sourceOwner, "openingHoursSource"));
  place.fieldContributors = fields;
  place.contributors = snapshotContributors(
    contributorsForFields(fields, Object.keys(fields)),
    contributorsForRecords(place.photos ?? []),
    contributorsForRecords(place.facts ?? []),
  );

  return { place, isLoading: nominatimLoading && !nominatimDetails };
}
