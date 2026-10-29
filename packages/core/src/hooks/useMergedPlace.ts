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
import {
  directPlaceDetailsId,
  hasUsablePlaceAddress,
  haveConflictingOsmIds,
  isLocalityOnlyAddress,
  isMovingDataSourcePlace,
  selectPlaceAddress,
} from "../utils/addressEvidence";
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
 *  2. Address selection retains explicit object tags and data-source ownership;
 *     unknown legacy candidates keep the existing resolver-first precedence.
 *  3. OSM-sourced fields (city, phone, website, openingHours, osmTags,
 *     description, wikipediaUrl, photos, facts, reviewLinks, rating, reviewCount):
 *     Nominatim/Overpass details win when available, selectedPlace fills gaps.
 *  4. Reverse geocoding fills address/city only when both OSM lookup and
 *     selectedPlace have nothing.
 *  5. dataSourceDetail: from selectedPlace if present, otherwise from
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
        directOsmReference: selected.directOsmReference,
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
    const captured = captureFieldContributors(owner, sourceField, field);
    // Preserve absence separately from authoritative empty. The shared capture
    // helper copies the child tree but always synthesizes its target parent.
    let sourceCaptured = owner.fieldContributors === undefined && owner.contributors !== undefined;
    let path = sourceField;
    while (owner.fieldContributors !== undefined && path) {
      if (owner.fieldContributors[path] !== undefined) {
        sourceCaptured = true;
        break;
      }
      const dot = path.lastIndexOf(".");
      path = dot < 0 ? "" : path.slice(0, dot);
    }
    if (!sourceCaptured) delete captured[field];
    Object.assign(fields, captured);
  };
  for (const field of Object.keys(base)) {
    if (!["contributors", "fieldContributors", "ids"].includes(field))
      transfer(field, nom ?? selected);
  }
  for (const field of ["id", "primaryScheme"] as const) transfer(field, selected);
  transfer("directOsmReference", selected);
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
      base.phone = selected.phone || nom.phone;
      base.website = selected.website || nom.website;
      base.openingHours = selected.openingHours || nom.openingHours;
    } else {
      base.phone = nom.phone || selected.phone;
      base.website = nom.website || selected.website;
      base.openingHours = nom.openingHours || selected.openingHours;
    }
    const addressOwner = selectPlaceAddress(selected, nom, isDataSourcePlace);
    base.address = addressOwner.address;
    base.addressEvidence = addressOwner.addressEvidence;
    transfer("address", addressOwner);
    transfer("addressEvidence", addressOwner, "address");
    const cityOwner =
      haveConflictingOsmIds(selected, nom) || (addressOwner === selected && selected.city)
        ? selected
        : isDataSourcePlace
          ? selected.city
            ? selected
            : nom
          : nom.city
            ? nom
            : selected;
    base.city = cityOwner.city;
    transfer("city", cityOwner);
    for (const field of ["phone", "website", "openingHours"] as const) {
      transfer(field, (isDataSourcePlace ? selected[field] : !nom[field]) ? selected : nom);
    }
  } else {
    if (!base.address && reverseGeo?.address) {
      base.address = reverseGeo.address;
      base.addressEvidence = reverseGeo.addressEvidence;
      transfer("address", reverseGeo);
      transfer("addressEvidence", reverseGeo, "address");
    }
    if (!base.city && reverseGeo?.city) {
      base.city = reverseGeo.city.split(",")[0].trim();
      transfer("city", reverseGeo);
    }
  }

  // Moving preview titles and known locality-only strings leave an address gap.
  if (
    isDataSourcePlace &&
    isMovingDataSourcePlace(selected) &&
    base.address === selected.name &&
    !hasUsablePlaceAddress(base)
  ) {
    base.address = "";
    base.addressEvidence = undefined;
  }
  if (
    (!base.address || (isDataSourcePlace && isLocalityOnlyAddress(base))) &&
    reverseGeo?.address
  ) {
    base.address = reverseGeo.address;
    base.addressEvidence = reverseGeo.addressEvidence;
    transfer("address", reverseGeo);
    transfer("addressEvidence", reverseGeo, "address");
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
  const placeDetailsId = selectedPlace
    ? directPlaceDetailsId(selectedPlace, isDataSourcePlace)
    : null;

  const { data: nominatimDetails, isLoading: nominatimLoading } = usePlaceDetails(
    placeDetailsId,
    selectedPlace?.coordinates,
    selectedPlace?.name,
    undefined,
    // Skip the server's Nominatim/Overpass address fallback when the client
    // already has one (data-source bridges populate address from the provider).
    Boolean(selectedPlace?.address),
  );

  const isVehicle = selectedPlace ? isMovingDataSourcePlace(selectedPlace) : false;
  const addressForReverse = selectedPlace
    ? selectPlaceAddress(selectedPlace, nominatimDetails, isDataSourcePlace)
    : null;
  const conflictingOsmIds = haveConflictingOsmIds(selectedPlace, nominatimDetails);
  const cityForReverse =
    selectedPlace?.city || (!conflictingOsmIds ? nominatimDetails?.city : undefined);
  const needsReverseGeo =
    isCoordinatePlace ||
    (isDataSourcePlace &&
      (isVehicle ||
        !addressForReverse ||
        !hasUsablePlaceAddress(addressForReverse, { allowReverse: true }) ||
        !cityForReverse?.trim()));
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
  // A matched data source's route evaluates its own hours; hours no candidate
  // evaluated show neutrally.
  const matchingCandidates = [
    ...(isDataSourcePlace ? [selectedPlace, nominatimDetails] : [nominatimDetails, selectedPlace]),
  ];
  const hoursCandidates = [...matchingCandidates, matchedDetail];
  const chosenHours = matchingOpeningHours(place.openingHours, hoursCandidates, now);
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
    const infoOwner = hoursCandidates.find(
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
