"use client";

import type { AutocompleteResult, LngLat } from "@openmapx/core";
import {
  brandSuggestionRows,
  CATEGORY_DEFINITIONS,
  coordinateId,
  decodeShortPlusCode,
  detectShortPlusCodeCity,
  matchCategorySuggestions,
  matchRecentSearches,
  parseCoordinateInput,
  parseDMSCoordinateInput,
  parsePlusCodeInput,
  presetSuggestionRows,
  rankAutocompleteRows,
  useAdaptiveDebounce,
  useAutocomplete,
  useBrandSuggest,
  useChipTranslations,
  useCountryFromCoordinates,
  useDataSources,
  useDebounce,
  useGeocoding,
  useLabeledPlaces,
  usePresetSuggest,
  useSearchSuggestions,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useRecentSearchStore } from "@/stores/recentSearchStore";

/** A category an integration's data source answers, offered among the search rows. */
export interface DataSourceCategory {
  id: string;
  label: string;
  iconPath?: string;
  integrationId: string;
}

export interface SuggestionRowsInput {
  query: string;
  locale: string;
  /** Rows are fetched only while someone can see them or an Enter waits on them. */
  suggesting: boolean;
  mapCenter: LngLat | null;
  mapZoom: number | undefined;
  /** A place anchors the search: the rows are categories to explore around it. */
  nearbyMode: boolean;
  /** Phone directions borrowed the search to choose a stop, so rows need a position. */
  stopSearch: boolean;
}

/**
 * The search box's rows for the typed text: saved, recent, category, preset,
 * brand and place rows ranked together, or a single row for coordinates and
 * plus codes, and the plain search of the visible area last. `settled` tells
 * when they describe the text as typed, so Enter can act on them.
 */
export function useSuggestionRows({
  query,
  locale,
  suggesting,
  mapCenter,
  mapZoom,
  nearbyMode,
  stopSearch,
}: SuggestionRowsInput) {
  const t = useTranslations("search");
  const tSaved = useTranslations("saved");
  const debouncedQuery = useAdaptiveDebounce(query, 150, 50);
  const debouncedGeoQuery = useDebounce(query, 400);
  // The text stays in the box after a place opens and the map flies there;
  // following the moving centre would ask for rows nobody sees.
  const suggestQuery = suggesting ? debouncedQuery : "";
  const geocodeQuery = suggesting ? debouncedGeoQuery : "";
  const suggestionBias = useMemo(
    () => (mapCenter ? { proximity: mapCenter, zoom: mapZoom } : null),
    [mapCenter, mapZoom],
  );

  const {
    data: autocompleteData,
    isFetching: autocompleteFetching,
    isPlaceholderData: autocompletePlaceholder,
  } = useAutocomplete(suggestQuery, locale, suggestionBias);
  const { data: geocodeData } = useGeocoding(geocodeQuery, locale, mapCenter);
  const { data: presetData } = usePresetSuggest(suggestQuery, locale);
  // One country lookup per ~1° cell: the value only steers brand ranking, so a
  // coarse cell is plenty and keeps the query cache from churning while panning.
  const centerLng = mapCenter?.[0];
  const centerLat = mapCenter?.[1];
  const countryProbe = useMemo<[number, number] | null>(
    () =>
      suggesting && centerLng !== undefined && centerLat !== undefined
        ? [Math.round(centerLng), Math.round(centerLat)]
        : null,
    [suggesting, centerLng, centerLat],
  );
  const { data: viewportCountry } = useCountryFromCoordinates(countryProbe);
  // Chains only: operators such as police forces or transit authorities are
  // catalogued too, but nobody types their name to find a shop.
  const { data: brandData } = useBrandSuggest(suggestQuery, viewportCountry ?? undefined, {
    kind: "brand",
  });
  const { data: chipTranslations = {} } = useChipTranslations(locale);
  const {
    data: aggregateSearchData,
    isFetching: aggregateSearchFetching,
    isPlaceholderData: aggregateSearchPlaceholder,
  } = useSearchSuggestions(suggestQuery, locale, mapCenter, 8);
  const recentSearches = useRecentSearchStore((s) => s.entries);
  const { data: labeledPlaces } = useLabeledPlaces();

  // Data source categories from integration manifests, offered only while the
  // API lists the source: an unlisted one would answer every search empty.
  // Until the list arrives, or when it cannot be read, every one is offered.
  const registry = useIntegrationRegistry();
  const { data: listedDataSources } = useDataSources();
  const dataSourceCategories = useMemo<DataSourceCategory[]>(() => {
    const listed = listedDataSources && new Set(listedDataSources.sources.map((s) => s.id));
    return registry
      .getWithSearchCategory()
      .filter((i) => listed === undefined || listed.has(i.id))
      .flatMap((i) => {
        const sc = i.frontend?.searchCategory as
          | { id: string; label?: string; iconPath?: string }
          | undefined;
        return sc
          ? [{ id: sc.id, label: sc.label ?? sc.id, iconPath: sc.iconPath, integrationId: i.id }]
          : [];
      });
  }, [registry, listedDataSources]);

  // A short plus code with a city decodes against the geocoded city.
  const q = query.trim();
  const shortPlusCity = detectShortPlusCodeCity(q);
  const debouncedCity = useDebounce(shortPlusCity?.city ?? "", 400);
  const { data: cityRefData } = useGeocoding(debouncedCity, locale);

  // Coordinates and plus codes name one point, shown as a single row.
  let syntheticResult: AutocompleteResult | null = null;
  if (q.length >= 2) {
    let parsed = parseCoordinateInput(q) ?? parseDMSCoordinateInput(q);
    if (!parsed && shortPlusCity && cityRefData?.[0]) {
      const lngLat = decodeShortPlusCode(shortPlusCity.code, cityRefData[0].coordinates);
      if (lngLat) parsed = { lngLat, label: `${shortPlusCity.code} ${shortPlusCity.city}` };
    }
    // A full plus code, or a short one without a city, decodes against the map centre.
    if (!parsed) parsed = parsePlusCodeInput(q, mapCenter ?? undefined);
    if (parsed) {
      syntheticResult = {
        id: `coordinate:${coordinateId(parsed.lngLat)}`,
        label: parsed.label,
        coordinates: parsed.lngLat,
        type: "address",
      };
    }
  }

  // Built-in POI categories plus the ones integrations register for search.
  const categorySuggestions = useMemo<AutocompleteResult[]>(
    () =>
      matchCategorySuggestions({
        query: q,
        categories: CATEGORY_DEFINITIONS,
        integrationCategories: dataSourceCategories,
        chipTranslations,
        sublabel: t("searchCategory"),
      }),
    [q, t, dataSourceCategories, chipTranslations],
  );
  const brandSuggestions = useMemo(
    () => brandSuggestionRows(brandData?.matches ?? [], t("searchBrand")),
    [brandData, t],
  );
  const recentSuggestions = useMemo(
    () => matchRecentSearches(recentSearches, q),
    [recentSearches, q],
  );
  const presetSuggestions = useMemo(
    () => presetSuggestionRows(presetData?.matches ?? [], t("searchCategory")),
    [presetData, t],
  );
  // Labeled places match their translated label, their place name and their address.
  const labeledSuggestions = useMemo<AutocompleteResult[]>(() => {
    if (q.length === 0) return [];
    const lower = q.toLowerCase();
    return (labeledPlaces ?? []).flatMap((lp): AutocompleteResult[] => {
      const label = lp.label === "home" || lp.label === "work" ? tSaved(lp.label) : lp.label;
      const matches =
        label.toLowerCase().includes(lower) ||
        lp.name.toLowerCase().includes(lower) ||
        (lp.address?.toLowerCase().includes(lower) ?? false);
      return matches
        ? [
            {
              id: `labeled-${lp.id}`,
              label,
              sublabel: lp.name + (lp.address ? ` — ${lp.address}` : ""),
              coordinates: [lp.lng, lp.lat],
              type: "labeled_place",
              labelKey: lp.label,
            },
          ]
        : [];
    });
  }, [q, labeledPlaces, tSaved]);

  const rankedSuggestions = useMemo(
    () =>
      rankAutocompleteRows(
        {
          saved: labeledSuggestions,
          recents: recentSuggestions,
          categories: categorySuggestions,
          presets: presetSuggestions,
          brands: brandSuggestions,
          places: [
            ...(aggregateSearchData?.suggestions ?? []),
            ...(q.length >= 2 ? (autocompleteData ?? []) : []),
          ],
        },
        { query: q, proximity: mapCenter ?? undefined, zoom: mapZoom },
      ),
    [
      q,
      labeledSuggestions,
      recentSuggestions,
      categorySuggestions,
      presetSuggestions,
      brandSuggestions,
      aggregateSearchData,
      autocompleteData,
      mapCenter,
      mapZoom,
    ],
  );
  // Otherwise the plain search of the visible area comes last, for a word that
  // names a kind of place rather than one of the rows above.
  const displaySuggestions: AutocompleteResult[] = syntheticResult
    ? [syntheticResult]
    : q.length >= 2 && mapCenter
      ? [
          ...rankedSuggestions,
          { id: "text-search", label: t("searchQueryInArea", { query: q }), type: "text_search" },
        ]
      : rankedSuggestions;

  // Nearby mode lists the chip categories to explore around the place, and a
  // free-text row once something is typed.
  const nearbySuggestions = useMemo<AutocompleteResult[]>(() => {
    if (!nearbyMode) return [];
    const lower = q.toLowerCase();
    const categories = CATEGORY_DEFINITIONS.filter(
      (cat) => cat.showInChipBar && (q === "" || cat.label.toLowerCase().includes(lower)),
    ).map((cat) => ({
      id: `nearby-cat-${cat.id}`,
      label: cat.label,
      type: "category" as const,
      iconPath: cat.iconPath,
      rawCategory: cat.id,
    }));
    if (q === "") return categories;
    return [
      { id: "nearby-freetext", label: t("searchFreeText", { query: q }), type: "poi" as const },
      ...categories,
    ];
  }, [nearbyMode, q, t]);

  // A stop needs a position: category, brand and AI rows have none to give.
  const rows = nearbyMode
    ? nearbySuggestions
    : stopSearch
      ? displaySuggestions.filter((row) => row.coordinates)
      : displaySuggestions;

  return {
    rows,
    rankedSuggestions,
    syntheticResult,
    dataSourceCategories,
    /** Whether any place-row request is in flight. */
    fetching: autocompleteFetching || aggregateSearchFetching,
    /** Whether the rows describe the text as typed: debounced and answered, not stand-ins. */
    settled:
      suggesting &&
      debouncedQuery === query &&
      !autocompleteFetching &&
      !autocompletePlaceholder &&
      !aggregateSearchFetching &&
      !aggregateSearchPlaceholder,
    geocodeQuery: debouncedGeoQuery,
    geocodeResults: geocodeData,
  };
}
