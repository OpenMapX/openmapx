import type {
  AutocompleteResult,
  BrandSummary,
  CategoryId,
  LabeledPlace,
  LngLat,
  Place,
  SearchResult,
} from "@openmapx/core";
import {
  API_ENDPOINTS,
  apiClient,
  createPlace,
  idsFromPrimaryOrCoords,
  isTransitRawCategory,
  resolveStopAsPlace,
} from "@openmapx/core";
import type { ContributingRecord, FieldContributors } from "@openmapx/mobility-core/contributors";
import {
  captureFieldContributors,
  contributorsForRecords,
} from "@openmapx/mobility-core/contributors";
import type { TransitStop } from "@openmapx/mobility-core/transit";

/** A selection's record in the search history: the text and the destination it named. */
export interface SearchHistoryEntry {
  search: string;
  destination: { id: string; label: string; coordinates?: LngLat };
}

/** What a selection opens once the search closes. */
export type SearchTarget =
  | {
      kind: "place";
      place: Place;
      /** Areas are framed by their boundary instead of a fixed zoom. */
      flyTo?: LngLat;
      /** A transit place whose stop is looked up near it, under this name. */
      transitLookup?: { coordinates: LngLat; name: string };
    }
  | { kind: "stop"; stop: TransitStop; flyTo?: LngLat }
  | { kind: "brand"; brand: BrandSummary }
  | { kind: "category"; categoryId: CategoryId }
  | { kind: "data-source"; sourceId: string }
  | { kind: "none" };

export type SearchAction =
  /** Phone directions borrowed the search to choose a stop. */
  | { kind: "pick-stop"; coordinates: LngLat; label: string }
  /** A past search runs again, as if typed and submitted. */
  | { kind: "run-recent"; text: string }
  /** The plain search of the visible area for the typed text. */
  | { kind: "search-area"; text: string }
  | {
      kind: "select";
      /** The text the box keeps, or null to leave it and let the blur close the list. */
      query: string | null;
      history?: SearchHistoryEntry;
      target: SearchTarget;
    }
  | { kind: "none" };

export interface SearchActionContext {
  /** The typed text, trimmed. */
  query: string;
  /** Whether phone directions borrowed the search to choose a stop. */
  stopSearch: boolean;
  /** Whether the selection enters the search history; Enter already recorded the typed text. */
  recordHistory: boolean;
  /** Category ids an integration's data source answers instead of the POI search. */
  dataSourceCategoryIds: readonly string[];
}

/** Carry displayed search fields into the selected place without blending hidden ranking metadata. */
function searchSelectionContributors(
  result: ContributingRecord & {
    fieldContributors?: FieldContributors;
    ids?: Record<string, string | undefined>;
  },
  nameField = "label",
  addressField = "label",
) {
  const fieldContributors = Object.fromEntries(
    Object.entries({
      name: nameField,
      address: addressField,
      addressEvidence: "addressEvidence",
      directOsmReference: "directOsmReference",
      coordinates: "coordinates",
      category: "type",
      rawCategory: "rawCategory",
    }).flatMap(([target, source]) =>
      Object.entries(captureFieldContributors(result, source, target)),
    ),
  );
  for (const scheme of Object.keys(result.ids ?? {}))
    Object.assign(fieldContributors, captureFieldContributors(result, `ids.${scheme}`));
  // Primary identity is retained even when the suggestion has no secondary IDs.
  Object.assign(fieldContributors, captureFieldContributors(result, "id", "ids"));
  return {
    fieldContributors,
    contributors: contributorsForRecords(
      Object.values(fieldContributors).map((contributors) => ({ contributors })),
    ),
  };
}

/** Areas are framed by their boundary; a fixed-zoom flight first would jump in and out. */
function flightTo(type: string, coordinates: LngLat): LngLat | undefined {
  return type === "region" ? undefined : coordinates;
}

/** The action a chosen suggestion row starts. */
export function resolveSearchAction(
  row: AutocompleteResult,
  context: SearchActionContext,
): SearchAction {
  if (context.stopSearch) {
    if (row.type === "recent_search") return { kind: "run-recent", text: row.label };
    return row.coordinates
      ? { kind: "pick-stop", coordinates: row.coordinates, label: row.label }
      : { kind: "none" };
  }
  if (row.type === "recent_search") return { kind: "run-recent", text: row.label };
  if (row.type === "text_search") return { kind: "search-area", text: context.query };

  const history: SearchHistoryEntry | undefined = context.recordHistory
    ? {
        search: row.label,
        destination: { id: row.id, label: row.label.slice(0, 160), coordinates: row.coordinates },
      }
    : undefined;
  const select = (target: SearchTarget): SearchAction => ({
    kind: "select",
    query: row.label,
    ...(history ? { history } : {}),
    target,
  });

  if (row.type === "labeled_place" && row.coordinates) {
    return select({
      kind: "place",
      flyTo: row.coordinates,
      place: createPlace({
        ...idsFromPrimaryOrCoords(row.id, row.coordinates),
        ...searchSelectionContributors(
          row,
          row.sublabel ? "sublabel" : "label",
          row.sublabel ? "sublabel" : "label",
        ),
        name: row.sublabel?.split(" — ")[0] ?? row.label,
        address: row.sublabel?.split(" — ")[1] ?? row.sublabel ?? row.label,
        coordinates: row.coordinates,
      }),
    });
  }
  if (row.type === "transit_stop" && row.transitStop) {
    return select({ kind: "stop", stop: row.transitStop, flyTo: row.coordinates });
  }
  if (row.type === "brand" && row.brand) return select({ kind: "brand", brand: row.brand });
  if (row.type === "category") {
    // The row id carries the category: "category-restaurants" → "restaurants".
    const categoryId = row.id.replace("category-", "");
    return select(
      context.dataSourceCategoryIds.includes(categoryId)
        ? { kind: "data-source", sourceId: categoryId }
        : { kind: "category", categoryId: categoryId as CategoryId },
    );
  }
  if (!row.coordinates) return select({ kind: "none" });

  const coordinates = row.coordinates;
  return select({
    kind: "place",
    flyTo: flightTo(row.type, coordinates),
    place: createPlace({
      ...idsFromPrimaryOrCoords(row.id, coordinates),
      ids: { ...row.ids, ...idsFromPrimaryOrCoords(row.id, coordinates).ids },
      ...searchSelectionContributors(
        row,
        "label",
        row.address ? "address" : row.sublabel ? "sublabel" : "label",
      ),
      name: row.label,
      address: row.address ?? row.sublabel ?? row.label,
      addressEvidence: row.addressEvidence,
      directOsmReference: row.directOsmReference,
      coordinates,
      category: row.type,
      rawCategory: row.rawCategory,
    }),
    // Only a geocoder's own transit classification looks a stop up, never a word in the label.
    ...(row.rawCategory && isTransitRawCategory(row.rawCategory)
      ? { transitLookup: { coordinates, name: row.label } }
      : {}),
  });
}

/** The action Enter starts when the geocoder's first result is a confident match. */
export function resolveGeocodeAction(
  result: SearchResult,
  address: string | undefined,
  isTransit: boolean,
): SearchAction {
  const place = createPlace({
    ...idsFromPrimaryOrCoords(result.id, result.coordinates),
    ids: { ...result.ids, ...idsFromPrimaryOrCoords(result.id, result.coordinates).ids },
    ...searchSelectionContributors(result, "label", result.address ? "address" : "label"),
    name: address ?? result.label,
    address: result.address ?? result.label,
    addressEvidence: result.addressEvidence,
    directOsmReference: result.directOsmReference,
    coordinates: result.coordinates,
    category: result.type,
    rawCategory: result.rawCategory,
  });
  return {
    kind: "select",
    query: null,
    target: {
      kind: "place",
      place,
      flyTo: flightTo(result.type, result.coordinates),
      ...(isTransit
        ? { transitLookup: { coordinates: result.coordinates, name: result.label } }
        : {}),
    },
  };
}

/** The action a saved Home, Work or custom place from the empty search starts. */
export function resolveLabeledPlaceAction(place: LabeledPlace, stopSearch: boolean): SearchAction {
  const coordinates: LngLat = [place.lng, place.lat];
  if (stopSearch) return { kind: "pick-stop", coordinates, label: place.name };
  return {
    kind: "select",
    query: place.label,
    target: {
      kind: "place",
      flyTo: coordinates,
      place: createPlace({
        ...idsFromPrimaryOrCoords(place.placeId ?? place.id, coordinates),
        name: place.name,
        address: place.address ?? place.name,
        coordinates,
      }),
    },
  };
}

/** Within about 500 m of a transit place, the stop whose name carries every word of `name`. */
export async function findTransitStopPlace(
  coordinates: LngLat,
  name: string,
  isCurrent: () => boolean,
): Promise<Place | null> {
  try {
    const delta = 0.005;
    const stops = await apiClient.get<TransitStop[]>(API_ENDPOINTS.transitStops, {
      sw_lat: String(coordinates[1] - delta),
      sw_lng: String(coordinates[0] - delta),
      ne_lat: String(coordinates[1] + delta),
      ne_lng: String(coordinates[0] + delta),
    });
    if (!isCurrent()) return null;
    // Every word of the name must be a word of the stop's name, then the
    // closest wins. A looser prefix match sent "Frankfurt Airport" to any stop
    // starting "Frankfurt ".
    const words = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? ([] as string[]);
    const distance = (stop: TransitStop) =>
      (stop.lng - coordinates[0]) ** 2 + (stop.lat - coordinates[1]) ** 2;
    const match = words.length
      ? stops
          .filter((stop) => {
            const stopWords = stop.name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? ([] as string[]);
            return words.every((word) => stopWords.includes(word));
          })
          .sort((a, b) => distance(a) - distance(b))[0]
      : undefined;
    if (match) return await resolveStopAsPlace(match);
  } catch {
    // The place panel opens without a stop.
  }
  return null;
}
