"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import DirectionsIcon from "@mui/icons-material/Directions";
import HighlightOffIcon from "@mui/icons-material/HighlightOff";
import MenuIcon from "@mui/icons-material/Menu";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import { useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { formatShortcut, getPlatform, parseShortcut } from "@openmapx/command-palette";
import type {
  AutocompleteResult,
  CategoryId,
  DistanceReference,
  LabeledPlace,
  LngLat,
  Place,
} from "@openmapx/core";
import {
  API_ENDPOINTS,
  apiClient,
  brandSuggestionRows,
  brandToFilter,
  CATEGORY_DEFINITIONS,
  coordinateId,
  createPlace,
  decodeShortPlusCode,
  detectShortPlusCodeCity,
  idsFromPrimaryOrCoords,
  isTransitRawCategory,
  makeSyntheticStopPlace,
  matchCategorySuggestions,
  matchRecentSearches,
  PANEL,
  parseCoordinateInput,
  parseDMSCoordinateInput,
  parsePlusCodeInput,
  presetSuggestionRows,
  rankAutocompleteRows,
  resolveStopAsPlace,
  useActiveSidePanel,
  useAdaptiveDebounce,
  useAutocomplete,
  useBrandSuggest,
  useCategorySearchStore,
  useChipTranslations,
  useCommandPaletteStore,
  useCountryFromCoordinates,
  useDataSourceStore,
  useDataSources,
  useDebounce,
  useDirectionsStore,
  useGeocoding,
  useLabeledPlaces,
  useMapStore,
  useMenuStore,
  usePlaceStore,
  usePresetSuggest,
  useSavedPlacesStore,
  useSearchStore,
  useSearchSuggestions,
  useSidebarStore,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { ContributingRecord, FieldContributors } from "@openmapx/mobility-core/contributors";
import {
  captureFieldContributors,
  contributorsForRecords,
} from "@openmapx/mobility-core/contributors";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountAvatarButton } from "@/components/auth/AccountAvatarButton";
import { SEARCH_INPUT_ID } from "@/components/command-palette/constants";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { NlpConsentDialog } from "@/components/ui/NlpConsentDialog";
import { usePlaceEnrichment } from "@/hooks/usePlaceEnrichment";
import { useMap } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";
import {
  launchExploreFromPlace,
  launchExploreTextSearch,
  launchTextSearch,
} from "@/lib/launchExplore";
import { SEARCH_BAR_HEIGHT, SEARCH_BAR_INSET } from "@/lib/layout";
import { useMeasuredMapObstruction } from "@/lib/mapObstructions";
import { servedAttributions } from "@/lib/servedAttributions";
import { useHydrated } from "@/lib/useHydrated";
import { useRecentSearchStore } from "@/stores/recentSearchStore";
import {
  AutocompleteDropdown,
  suggestionListboxId,
  suggestionOptionId,
} from "./AutocompleteDropdown";
import { NlpSearchCard } from "./NlpSearchCard";
import { SearchEmptyState } from "./SearchEmptyState";
import {
  decideSearchSubmission,
  type NlpSubmissionContext,
  type SearchBarSurface,
} from "./searchSubmission";
import { useSearchSubmission } from "./useSearchSubmission";
import { VoiceSearchButton } from "./VoiceSearchButton";

/** Pre-parsed once at module load — the shortcut never changes, no need to
 *  re-parse it on every SearchBar render. */
const PALETTE_SHORTCUT = parseShortcut("Mod+K");

export type { SearchBarSurface } from "./searchSubmission";

/**
 * The map-obstruction registry is keyed by id alone, so each surface needs its
 * own — otherwise the second bar to mount overwrites the first's entry and
 * either one's unmount deletes it.
 */
const OBSTRUCTION_ID: Record<SearchBarSurface, string> = {
  map: "search-bar",
  "street-level": "street-level-search-bar",
};

export interface SearchBarProps {
  surface?: SearchBarSurface;
}

/** Rows are keyed by type and id together: a category and a place can share an id. */
function rowKey(row: AutocompleteResult): string {
  return `${row.type}:${row.id}`;
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

export function SearchBar({ surface = "map" }: SearchBarProps) {
  const t = useTranslations("search");
  const tSaved = useTranslations("saved");
  const tCmd = useTranslations("commandPalette");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const muiTheme = useTheme();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const { query, isFocused, setQuery, setIsFocused, setSuggestions, setResults } = useSearchStore();
  const { setSelectedPlace } = usePlaceStore();
  const { selectWithEnrichment, cancelEnrichment } = usePlaceEnrichment();
  const { isOpen: hasSidePanel, close: closeSidePanel } = useActiveSidePanel();
  const { isOpen: directionsOpen, open: openDirections } = useDirectionsStore();
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const setActiveCategory = useCategorySearchStore((s) => s.setActiveCategory);
  const clearCategory = useCategorySearchStore((s) => s.clearCategory);
  const setBrandFilter = useCategorySearchStore((s) => s.setBrandFilter);
  const anchor = useCategorySearchStore((s) => s.anchor);
  const exploreBoxOpen = useCategorySearchStore((s) => s.exploreBoxOpen);
  // Nearby/Explore mode: a place is the anchor. Reuses this search bar, adding a
  // brand-coloured pill and routing selections to the place-anchored category search.
  const nearbyMode = anchor !== null;
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const setActiveSource = useDataSourceStore((s) => s.setActiveSource);
  const openMenu = useMenuStore((s) => s.open);
  const { selectedListId, clearSelectedList } = useSavedPlacesStore();
  const { flyTo, mapRef } = useMap();
  const userLocation = useMapStore((s) => s.userLocation);
  const inputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keyed by row rather than position, so rows arriving late cannot slide a
  // different place under the highlight.
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [barEl, setBarEl] = useState<HTMLDivElement | null>(null);
  const shortcutPlatform = useHydrated() ? getPlatform() : "other";
  const debouncedQuery = useAdaptiveDebounce(query, 150, 50);
  const debouncedGeoQuery = useDebounce(query, 400);
  const {
    beginSubmission,
    runSubmission,
    deferSubmission,
    settlePending,
    startNlp,
    cancelSubmission,
    cancelPending: cancelPendingSubmit,
    pending,
    nlp,
  } = useSearchSubmission({
    surface,
    query,
    locale,
    directionsOpen,
    cancelEnrichment,
    executeResolvedSubmit,
    captureViewport: () => {
      const center = mapRef.current?.getCenter();
      const bounds = mapRef.current?.getBounds();
      return {
        mapCenter: center ? [center.lng, center.lat] : null,
        mapBbox: bounds
          ? {
              west: bounds.getWest(),
              south: bounds.getSouth(),
              east: bounds.getEast(),
              north: bounds.getNorth(),
            }
          : null,
      };
    },
    blurInput: () => inputRef.current?.blur(),
    searchText: (text) => launchTextSearch(mapRef.current, text),
  });
  // Suggestions are only fetched while someone can see them or an Enter waits
  // on them. The text stays in the box after a place opens, and the map then
  // flies there; following the moving centre would request a fresh batch for
  // nobody at every step of the flight.
  const suggesting = isFocused || pending;
  const suggestQuery = suggesting ? debouncedQuery : "";
  const geocodeQuery = suggesting ? debouncedGeoQuery : "";

  // Snapshot of the viewport, read from the map on each render (cheap ref
  // reads). Suggestions are biased towards it and ranked by distance from it;
  // the hooks round it, so small pans reuse cached answers.
  const mapCenterRaw = mapRef.current?.getCenter();
  const mapCenterLng = mapCenterRaw?.lng;
  const mapCenterLat = mapCenterRaw?.lat;
  const mapZoom = mapRef.current?.getZoom();
  const mapCenter = useMemo<LngLat | null>(
    () =>
      mapCenterLng !== undefined && mapCenterLat !== undefined
        ? [mapCenterLng, mapCenterLat]
        : null,
    [mapCenterLng, mapCenterLat],
  );
  const suggestionBias = useMemo(
    () => (mapCenter ? { proximity: mapCenter, zoom: mapZoom } : null),
    [mapCenter, mapZoom],
  );

  const {
    data: autocompleteData,
    isFetching,
    isPlaceholderData: autocompletePlaceholder,
  } = useAutocomplete(suggestQuery, locale, suggestionBias);
  const { data: geocodeData } = useGeocoding(geocodeQuery, locale, mapCenter);
  const { data: presetData } = usePresetSuggest(suggestQuery, locale);
  // One country lookup per ~1° cell: the value only steers brand ranking, so a
  // coarse cell is plenty and keeps the query cache from churning while panning.
  const countryProbe = useMemo<[number, number] | null>(
    () =>
      suggesting && mapCenterLng !== undefined && mapCenterLat !== undefined
        ? [Math.round(mapCenterLng), Math.round(mapCenterLat)]
        : null,
    [suggesting, mapCenterLng, mapCenterLat],
  );
  const { data: viewportCountry } = useCountryFromCoordinates(countryProbe);
  // Chains only: operators such as police forces or transit authorities are
  // catalogued too, but nobody types their name to find a shop.
  const { data: brandData } = useBrandSuggest(suggestQuery, viewportCountry ?? undefined, {
    kind: "brand",
  });
  const { data: chipTranslations = {} } = useChipTranslations(locale);
  const recentSearches = useRecentSearchStore((s) => s.entries);

  const suggestionDistanceReference: DistanceReference | null = userLocation
    ? { kind: "user_location", coordinates: userLocation }
    : mapCenter
      ? { kind: "search_area_center", coordinates: mapCenter }
      : null;
  const {
    data: aggregateSearchData,
    isFetching: aggregateSearchFetching,
    isPlaceholderData: aggregateSearchPlaceholder,
  } = useSearchSuggestions(suggestQuery, locale, mapCenter, 8);
  // Voice dictation and recent-search rows fill the input and then run through
  // the normal submit path, so they behave exactly like typing and Enter.
  const [submitAfterFlush, setSubmitAfterFlush] = useState(false);
  const handleVoiceResult = useCallback(
    (transcript: string, isFinal: boolean) => {
      cancelSubmission();
      setQuery(transcript);
      if (isFinal) setSubmitAfterFlush(true);
    },
    [setQuery, cancelSubmission],
  );

  // Once the new text has flushed into the query, submit — deferred to an
  // effect so the query state has updated before `requestSubmit` reads it.
  useEffect(() => {
    if (!submitAfterFlush) return;
    setSubmitAfterFlush(false);
    inputRef.current?.form?.requestSubmit();
  }, [submitAfterFlush]);

  const addRecentSearch = useRecentSearchStore((s) => s.add);
  const clearRecentSearches = useRecentSearchStore((s) => s.clear);

  // Labeled places (Home, Work, custom) for search suggestions
  const { data: labeledPlaces } = useLabeledPlaces();

  // Data source categories from integration manifests, offered only while the
  // API lists the source: an unlisted one would answer every search empty.
  // Until the list arrives, or when it cannot be read, every one is offered.
  const registry = useIntegrationRegistry();
  const { data: listedDataSources } = useDataSources();
  const dataSourceCategories = useMemo(() => {
    const listed = listedDataSources && new Set(listedDataSources.sources.map((s) => s.id));
    const withSearchCat = registry
      .getWithSearchCategory()
      .filter((i) => listed === undefined || listed.has(i.id));
    return withSearchCat
      .map((i) => {
        const sc = i.frontend?.searchCategory as
          | { id: string; label?: string; iconPath?: string }
          | undefined;
        if (!sc) return null;
        return { id: sc.id, label: sc.label ?? sc.id, iconPath: sc.iconPath, integrationId: i.id };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [registry, listedDataSources]);

  // Clean up blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    };
  }, []);

  // Entering nearby mode (clicked "Nearby" on a place): clear the query and
  // focus so the category picker dropdown opens in the reused search bar.
  useEffect(() => {
    if (exploreBoxOpen) {
      setQuery("");
      setIsFocused(true);
      inputRef.current?.focus();
    }
  }, [exploreBoxOpen, setQuery, setIsFocused]);

  const cancelBlur = useCallback(() => {
    if (blurTimeoutRef.current !== null) clearTimeout(blurTimeoutRef.current);
    blurTimeoutRef.current = null;
  }, []);
  const handleBlur = useCallback(() => {
    cancelPendingSubmit();
    cancelBlur();
    blurTimeoutRef.current = setTimeout(() => {
      blurTimeoutRef.current = null;
      setIsFocused(false);
    }, 150);
  }, [cancelPendingSubmit, cancelBlur, setIsFocused]);

  // When user types a short plus code with city, geocode the city name to get
  // the reference coordinates for decoding.
  const shortPlusCity = detectShortPlusCodeCity(query.trim());
  const debouncedCity = useDebounce(shortPlusCity?.city ?? "", 400);
  const { data: cityRefData } = useGeocoding(debouncedCity, locale);

  useEffect(() => {
    setSuggestions(query.trim().length < 2 ? [] : (autocompleteData ?? []));
  }, [autocompleteData, query, setSuggestions]);

  useEffect(() => {
    setResults(geocodeData ?? []);
  }, [geocodeData, setResults]);

  // Detect coordinate / plus-code input and create a synthetic suggestion
  const q = query.trim();
  let syntheticResult: AutocompleteResult | null = null;
  if (q.length >= 2) {
    let parsed = parseCoordinateInput(q) ?? parseDMSCoordinateInput(q);

    if (!parsed) {
      // Short plus code with city: use geocoded city coordinates as reference
      if (shortPlusCity && cityRefData?.[0]) {
        const lngLat = decodeShortPlusCode(shortPlusCity.code, cityRefData[0].coordinates);
        if (lngLat) parsed = { lngLat, label: `${shortPlusCity.code} ${shortPlusCity.city}` };
      }

      // Full plus code or short code without city: use map center as reference
      if (!parsed) parsed = parsePlusCodeInput(q, mapCenter ?? undefined);
    }

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

  // Labeled places — match against translated label name, place name, and address
  const labeledSuggestions = useMemo<AutocompleteResult[]>(
    () =>
      (labeledPlaces ?? [])
        .filter((lp) => {
          if (q.length === 0) return false;
          const ql = q.toLowerCase();
          const translatedLabel =
            lp.label === "home" || lp.label === "work" ? tSaved(lp.label) : lp.label;
          return (
            translatedLabel.toLowerCase().includes(ql) ||
            lp.name.toLowerCase().includes(ql) ||
            (lp.address?.toLowerCase().includes(ql) ?? false)
          );
        })
        .map((lp): AutocompleteResult => {
          const translatedLabel =
            lp.label === "home" || lp.label === "work" ? tSaved(lp.label) : lp.label;
          return {
            id: `labeled-${lp.id}`,
            label: translatedLabel,
            sublabel: lp.name + (lp.address ? ` — ${lp.address}` : ""),
            coordinates: [lp.lng, lp.lat],
            type: "labeled_place",
            labelKey: lp.label,
          };
        }),
    [q, labeledPlaces, tSaved],
  );

  const rankedSuggestions = useMemo(
    () =>
      rankAutocompleteRows(
        {
          saved: labeledSuggestions,
          recents: recentSuggestions,
          categories: categorySuggestions,
          presets: presetSuggestions,
          brands: brandSuggestions,
          // Straight from the query, not the store copy an effect writes a
          // render later: Enter must act on the rows for the text as typed.
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
  // Coordinates and plus codes name one point; nothing else is worth listing.
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

  // Nearby mode: the dropdown shows category suggestions (+ a free-text item)
  // anchored to the place, mirroring the old ExploreSearchBox picker.
  const nearbySuggestions = useMemo<AutocompleteResult[]>(() => {
    if (!nearbyMode) return [];
    const lower = q.toLowerCase();
    const cats = CATEGORY_DEFINITIONS.filter(
      (cat) => cat.showInChipBar && (q === "" || cat.label.toLowerCase().includes(lower)),
    ).map((cat) => ({
      id: `nearby-cat-${cat.id}`,
      label: cat.label,
      type: "category" as const,
      iconPath: cat.iconPath,
      rawCategory: cat.id,
    }));
    if (q === "") return cats;
    return [
      { id: "nearby-freetext", label: t("searchFreeText", { query: q }), type: "poi" as const },
      ...cats,
    ];
  }, [nearbyMode, q, t]);

  // Mobile: when the search is focused, the bar takes over the full viewport
  // Pure CSS transition — same component,same focus/dropdown state,
  // just a different layout.
  const fullScreen = isMobile && isFocused;

  // Desktop keeps the bar inside the rail's column, which is already registered
  // as an obstruction; a full-screen search covers the map entirely, and
  // framing against that would leave nothing to aim at. The street-level viewer
  // covers it just as completely, so the bar riding on it registers nothing.
  useMeasuredMapObstruction(
    OBSTRUCTION_ID[surface],
    "top",
    surface === "map" && isMobile && !fullScreen ? barEl : null,
  );

  const effectiveSuggestions = nearbyMode ? nearbySuggestions : displaySuggestions;
  const listIdPrefix = OBSTRUCTION_ID[surface];
  const highlightedIndex =
    highlightedKey === null
      ? -1
      : effectiveSuggestions.findIndex((row) => rowKey(row) === highlightedKey);

  // Suggestions describe the text as typed only once the debounce has caught
  // up and no request for it is still in flight or standing in as a placeholder.
  const suggestionsSettled =
    suggesting &&
    debouncedQuery === query &&
    !isFetching &&
    !autocompletePlaceholder &&
    !aggregateSearchFetching &&
    !aggregateSearchPlaceholder;
  useEffect(() => {
    if (suggestionsSettled) settlePending();
  }, [suggestionsSettled, settlePending]);

  useEffect(() => {
    if (directionsOpen) cancelEnrichment();
  }, [directionsOpen, cancelEnrichment]);

  if (directionsOpen) return null;

  // Attribution follows the visible ranked rows, not the response envelope.
  const visibleAttributions = servedAttributions(registry, effectiveSuggestions);
  const nlpData = nlp.data;
  const showNlpCard = !nearbyMode && nlp.showCard;
  const showConsentDialog = !nearbyMode && nlp.showConsent;
  const nlpCard =
    showNlpCard && nlpData ? (
      <NlpSearchCard
        intent={nlpData.intent}
        providerLabel={nlpData.providerLabel}
        onActivate={nlp.activate}
      />
    ) : null;
  // While a submitted NL query is parsing, show a loading row so the user gets
  // feedback during the (slow) inference instead of a frozen-looking bar.
  const nlpPending = nlp.pending;
  const nlpLoadingCard = nlpPending ? (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.5 }}>
      <CircularProgress size={18} />
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {t("aiUnderstanding")}
      </Typography>
    </Box>
  ) : null;
  // While the first results load, the area-search row alone would stand in
  // for a list; the loading skeleton shows instead until real rows arrive.
  const awaitingFirstRows =
    (isFetching || aggregateSearchFetching) &&
    effectiveSuggestions.every((row) => row.type === "text_search");
  const showDropdown =
    isFocused &&
    ((effectiveSuggestions.length > 0 && !awaitingFirstRows) || showNlpCard || nlpPending);
  const showEmptySearch = isFocused && !nearbyMode && q.length === 0;

  const resolveTransitStop = async (
    coords: LngLat,
    name: string,
    isCurrent: () => boolean,
  ): Promise<Place | null> => {
    try {
      const delta = 0.005; // ~500m
      const stops = await apiClient.get<TransitStop[]>(API_ENDPOINTS.transitStops, {
        sw_lat: String(coords[1] - delta),
        sw_lng: String(coords[0] - delta),
        ne_lat: String(coords[1] + delta),
        ne_lng: String(coords[0] + delta),
      });
      if (!isCurrent()) return null;
      // Require every query token to appear as a token in the stop name and
      // then pick the closest one. The previous 10-char-prefix substring
      // match was far too loose — it routed "Frankfurt Airport" to a random
      // stop containing "Frankfurt " (e.g. "Frankfurt am Main, Tor 31").
      const queryTokens = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? ([] as string[]);
      const match = queryTokens.length
        ? stops
            .filter((s) => {
              const stopTokens = s.name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? ([] as string[]);
              return queryTokens.every((t) => stopTokens.includes(t));
            })
            .sort(
              (a, b) =>
                (a.lng - coords[0]) ** 2 +
                (a.lat - coords[1]) ** 2 -
                ((b.lng - coords[0]) ** 2 + (b.lat - coords[1]) ** 2),
            )[0]
        : undefined;
      if (match) return await resolveStopAsPlace(match);
    } catch {
      // Silently fall back to place panel
    }
    return null;
  };

  const highlightAt = (index: number) => {
    const row = effectiveSuggestions[index];
    setHighlightedKey(row ? rowKey(row) : null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || isComposingRef.current) return;
    if (e.key === "Escape") {
      cancelSubmission();
      setIsFocused(false);
      setHighlightedKey(null);
      return;
    }
    if (!showDropdown) {
      // Escape closed the list without leaving the input; the arrow keys bring it back.
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && q.length > 0) {
        e.preventDefault();
        setIsFocused(true);
      }
      return;
    }
    const count = effectiveSuggestions.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightAt(highlightedIndex < count - 1 ? highlightedIndex + 1 : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightAt(highlightedIndex > 0 ? highlightedIndex - 1 : count - 1);
    } else if (e.key === "Enter" && highlightedIndex >= 0) {
      e.preventDefault();
      handleSelectAny(effectiveSuggestions[highlightedIndex]);
    }
  };

  const updateQuery = (newValue: string) => {
    cancelSubmission();
    // In nearby mode keep the anchor (don't clearCategory — that would drop it);
    // the nearby dropdown re-filters and a selection relaunches the search.
    if (!nearbyMode) {
      // If user modifies the query while a category/data source is active, clear it
      if (activeCategory !== null) {
        clearCategory();
      }
      if (activeSource !== null) {
        setActiveSource(null);
      }
    }
    setHighlightedKey(null);
    setQuery(newValue);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateQuery(e.target.value);
    // Typing again after Escape reopens the list.
    setIsFocused(true);
  };

  // A past search runs again, the same as typing it and pressing Enter.
  const handleSelectRecent = (recent: string) => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    updateQuery(recent);
    setIsFocused(true);
    inputRef.current?.focus();
    setSubmitAfterFlush(true);
  };

  const handleClearRecent = () => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    clearRecentSearches();
    setIsFocused(true);
    inputRef.current?.focus();
  };

  const handleSubmit = (e: React.FormEvent) => {
    // AuthDialog is portaled from the mobile account avatar inside this form.
    // React portal events follow the component tree, so its inner form's submit
    // reaches this handler unless we limit search handling to this form itself.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (isComposingRef.current || !q) return;
    const nlpContext = beginSubmission();
    if (nearbyMode) {
      inputRef.current?.blur();
      if (anchor && q.length > 0) launchExploreTextSearch(mapRef.current, anchor, q);
      return;
    }
    if (syntheticResult) {
      addRecentSearch(q);
      inputRef.current?.blur();
      handleSelect(syntheticResult, false);
      return;
    }
    // Act on the suggestions for exactly this text: wait for them to arrive
    // rather than choosing from rows that belong to an earlier keystroke.
    if (!suggestionsSettled) {
      deferSubmission(nlpContext);
      return;
    }
    runSubmission(nlpContext);
  };

  function executeResolvedSubmit(nlpContext: NlpSubmissionContext) {
    addRecentSearch(q);
    const action = decideSearchSubmission({
      query,
      rankedSuggestions,
      proximity: mapCenter ?? undefined,
      zoom: mapZoom,
      geocodeQuery: debouncedGeoQuery,
      geocodeResults: geocodeData,
    });
    if (action.kind === "open-row") {
      inputRef.current?.blur();
      handleSelect(action.row, false);
      return;
    }
    if (action.kind === "choose-row") {
      setIsFocused(true);
      setHighlightedKey(action.row ? rowKey(action.row) : null);
      return;
    }
    if (action.kind === "open-geocode") {
      const { result: first, address, isTransit } = action;
      inputRef.current?.blur();
      // Area results (cities/regions/countries) are framed by PlaceBoundaryLayer,
      // which fits the map to the admin boundary — flying to a fixed zoom first
      // would just cause a zoom-in-then-out jump.
      if (first.type !== "region") flyTo(first.coordinates, 15);
      const firstPlace = createPlace({
        ...idsFromPrimaryOrCoords(first.id, first.coordinates),
        ids: { ...first.ids, ...idsFromPrimaryOrCoords(first.id, first.coordinates).ids },
        ...searchSelectionContributors(first, "label", first.address ? "address" : "label"),
        name: address ?? first.label,
        address: first.address ?? first.label,
        addressEvidence: first.addressEvidence,
        directOsmReference: first.directOsmReference,
        coordinates: first.coordinates,
        category: first.type,
        rawCategory: first.rawCategory,
      });
      if (isTransit) {
        selectWithEnrichment(firstPlace, (isCurrent) =>
          resolveTransitStop(first.coordinates, first.label, isCurrent),
        );
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      } else {
        setSelectedPlace(firstPlace);
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      }
      return;
    }
    // Not a confident place match → run the NL parse and keep the dropdown open
    // (place candidates + AI card) so the user disambiguates. Never auto-navigate
    // to a low-relevance geocode result. A parse with nothing to offer falls
    // back to the search of the visible area through the submission controller.
    if (startNlp(nlpContext)) return;
    // Without the AI parse, Enter searches the visible area for the text.
    setIsFocused(false);
    inputRef.current?.blur();
    launchTextSearch(mapRef.current, q);
  }

  const handleSelect = (result: AutocompleteResult, recordHistory = true) => {
    cancelSubmission();
    if (result.type === "recent_search") {
      handleSelectRecent(result.label);
      return;
    }
    if (result.type === "text_search") {
      addRecentSearch(q);
      setIsFocused(false);
      inputRef.current?.blur();
      launchTextSearch(mapRef.current, q);
      return;
    }
    if (recordHistory) addRecentSearch(result.label);
    if (result.type === "labeled_place" && result.coordinates) {
      setQuery(result.label);
      setIsFocused(false);
      flyTo(result.coordinates, 15);
      setSelectedPlace(
        createPlace({
          ...idsFromPrimaryOrCoords(result.id, result.coordinates),
          ...searchSelectionContributors(
            result,
            result.sublabel ? "sublabel" : "label",
            result.sublabel ? "sublabel" : "label",
          ),
          name: result.sublabel?.split(" — ")[0] ?? result.label,
          address: result.sublabel?.split(" — ")[1] ?? result.sublabel ?? result.label,
          coordinates: result.coordinates,
        }),
      );
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
      return;
    }

    if (result.type === "transit_stop" && result.transitStop) {
      setQuery(result.label);
      setIsFocused(false);
      if (result.coordinates) flyTo(result.coordinates, 15);
      const stop = result.transitStop;
      selectWithEnrichment(makeSyntheticStopPlace(stop), () => resolveStopAsPlace(stop));
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
      return;
    }

    if (result.type === "brand" && result.brand) {
      setBrandFilter(result.brand, brandToFilter(result.brand));
      useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
      setQuery(result.label);
      setIsFocused(false);
      return;
    }

    if (result.type === "category") {
      // Extract category id from the synthetic id ("category-restaurants" → "restaurants")
      const catId = result.id.replace("category-", "");
      const dsMatch = dataSourceCategories.find((ds) => ds.id === catId);
      if (dsMatch) {
        // Route to data source system (manifest-driven)
        clearCategory();
        setActiveSource(dsMatch.id);
        useSidebarStore.getState().openSidebar(PANEL.DATASOURCE);
      } else {
        setActiveCategory(catId as Parameters<typeof setActiveCategory>[0]);
        useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
      }
      setQuery(result.label);
      setIsFocused(false);
      return;
    }

    setQuery(result.label);
    setIsFocused(false);
    if (result.coordinates) {
      const coords = result.coordinates;
      // Area results are framed by PlaceBoundaryLayer (fit to admin boundary);
      // skip the fixed-zoom fly to avoid a zoom-in-then-out jump.
      if (result.type !== "region") flyTo(coords, 15);
      const suggestionPlace = createPlace({
        ...idsFromPrimaryOrCoords(result.id, coords),
        ids: { ...result.ids, ...idsFromPrimaryOrCoords(result.id, coords).ids },
        ...searchSelectionContributors(
          result,
          "label",
          result.address ? "address" : result.sublabel ? "sublabel" : "label",
        ),
        name: result.label,
        address: result.address ?? result.sublabel ?? result.label,
        addressEvidence: result.addressEvidence,
        directOsmReference: result.directOsmReference,
        coordinates: coords,
        category: result.type,
        rawCategory: result.rawCategory,
      });
      // Route to a transit-stop lookup only when the geocoder itself classified
      // the result as transit infrastructure — never on a label-keyword match.
      if (result.rawCategory && isTransitRawCategory(result.rawCategory)) {
        selectWithEnrichment(suggestionPlace, (isCurrent) =>
          resolveTransitStop(coords, result.label, isCurrent),
        );
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      } else {
        setSelectedPlace(suggestionPlace);
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      }
    }
  };

  // Nearby mode: route a category pick / free-text to the place-anchored search.
  const handleNearbySelect = (result: AutocompleteResult) => {
    cancelSubmission();
    if (!anchor) return;
    setIsFocused(false);
    inputRef.current?.blur();
    if (result.id === "nearby-freetext") {
      if (q.length > 0) launchExploreTextSearch(mapRef.current, anchor, q);
      return;
    }
    const catId = result.rawCategory as CategoryId | undefined;
    if (catId) launchExploreFromPlace(mapRef.current, anchor, catId, result.label);
  };

  const handleSelectAny = (result: AutocompleteResult) => {
    if (nearbyMode) handleNearbySelect(result);
    else handleSelect(result);
  };

  // Cancel nearby search (the brand pill's ✕): exit nearby mode and reopen the
  // place the search was started from.
  const handleCancelNearby = () => {
    cancelSubmission();
    const place = anchor;
    clearCategory();
    setQuery("");
    setIsFocused(false);
    if (place) {
      setSelectedPlace(place);
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
    }
  };

  const showSkeleton =
    !nearbyMode &&
    isFocused &&
    query.trim().length >= 2 &&
    (isFetching || aggregateSearchFetching) &&
    !showDropdown &&
    !syntheticResult;

  const handleBack = () => {
    cancelSubmission();
    setIsFocused(false);
    inputRef.current?.blur();
  };

  const handleSelectLabeledPlace = (place: LabeledPlace) => {
    cancelSubmission();
    setQuery(place.label);
    setIsFocused(false);
    flyTo([place.lng, place.lat], 15);
    setSelectedPlace(
      createPlace({
        ...idsFromPrimaryOrCoords(place.placeId ?? place.id, [place.lng, place.lat]),
        name: place.name,
        address: place.address ?? place.name,
        coordinates: [place.lng, place.lat],
      }),
    );
    useSidebarStore.getState().openSidebar(PANEL.PLACE);
  };

  return (
    <>
      {showConsentDialog && (
        <NlpConsentDialog
          open
          providers={nlp.consentProviders}
          onAccept={nlp.acceptConsent}
          onDecline={nlp.declineConsent}
        />
      )}
      {/* Full-screen backdrop on mobile while the search is focused — the
          bar and results panel float on this white surface, hiding the map
          and bottom sheet underneath. */}
      {fullScreen && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            bgcolor: "background.paper",
            zIndex: 12,
          }}
        />
      )}
      <Box
        ref={setBarEl}
        // React focus capture follows our credit dialogs through their portals.
        // Moving among the input, controls and dialogs still belongs to search;
        // leaving either search surface starts the ordinary dismissal delay.
        onFocusCapture={cancelBlur}
        onBlurCapture={handleBlur}
        sx={{
          position: "absolute",
          top: `calc(${SEARCH_BAR_INSET}px + var(--omx-safe-top))`,
          left: `calc(${SEARCH_BAR_INSET}px + var(--omx-safe-left))`,
          right: {
            xs: `calc(${SEARCH_BAR_INSET}px + var(--omx-safe-right))`,
            sm: "auto",
          },
          // Above CategoryChips (z-index 10) so the dropdown covers the chip
          // band on mobile when the user is typing — the chips stay rendered
          // (cheap, ready when search is dismissed) but visually hidden. In
          // fullscreen the bar sits above the white backdrop (z 12).
          zIndex: fullScreen ? 13 : 11,
          width: { xs: "auto", sm: "auto" },
        }}
      >
        <Paper
          elevation={fullScreen ? 0 : isFocused ? 4 : 2}
          sx={{
            width: { xs: "100%", sm: 376 },
            borderRadius:
              !fullScreen && (showDropdown || showEmptySearch) ? "24px 24px 16px 16px" : "24px",
            overflow: "hidden",
            transition: "box-shadow 0.2s, border-radius 0.15s, background-color 0.15s",
            // Bar turns into a light grey pill while focused,
            // signalling the active state without changing
            // its size or position.
            bgcolor: fullScreen ? "action.hover" : "background.paper",
          }}
        >
          {/* Search input row */}
          <Box
            component="form"
            onSubmit={handleSubmit}
            sx={{
              display: "flex",
              alignItems: "center",
              height: SEARCH_BAR_HEIGHT,
              px: 0.5,
              // The app-wide MuiIconButton override sets borderRadius: 8 (a
              // rounded square) which clashes with the pill-shaped search bar.
              // Force circular hover/focus halos for icons inside the bar so
              // they feel native to its rounded geometry.
              "& .MuiIconButton-root": { borderRadius: "50%" },
            }}
          >
            {fullScreen ? (
              <IconButton
                size="small"
                sx={{ ml: 0.5, mr: 0.5 }}
                onClick={handleBack}
                aria-label={tCommon("back")}
              >
                <ArrowBackIcon sx={{ fontSize: 22, color: "text.secondary" }} />
              </IconButton>
            ) : selectedListId ? (
              <IconButton size="small" sx={{ ml: 0.5, mr: 0.5 }} onClick={clearSelectedList}>
                <ArrowBackIcon sx={{ fontSize: 22, color: "text.secondary" }} />
              </IconButton>
            ) : (
              <IconButton
                size="small"
                sx={{ ml: 0.5, mr: 0.5 }}
                onClick={openMenu}
                aria-label={t("menuAriaLabel")}
              >
                <MenuIcon sx={{ fontSize: 22, color: "text.secondary" }} />
              </IconButton>
            )}

            <InputBase
              inputRef={inputRef}
              value={query}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onFocus={() => setIsFocused(true)}
              placeholder={
                nearbyMode && anchor
                  ? t("searchNearbyName", { name: anchor.name })
                  : t("placeholder")
              }
              inputProps={{
                id: SEARCH_INPUT_ID,
                "aria-label": t("ariaLabel"),
                role: "combobox",
                "aria-autocomplete": "list",
                "aria-expanded": showDropdown,
                "aria-controls": showDropdown ? suggestionListboxId(listIdPrefix) : undefined,
                "aria-activedescendant":
                  showDropdown && highlightedIndex >= 0
                    ? suggestionOptionId(listIdPrefix, highlightedIndex)
                    : undefined,
              }}
              sx={{
                flex: 1,
                fontSize: 16,
                "& input": {
                  padding: 0,
                  paddingLeft: "8px",
                  "&::placeholder": { color: "text.secondary", opacity: 1 },
                },
              }}
            />

            <VoiceSearchButton onResult={handleVoiceResult} />

            {fullScreen && query.length > 0 ? (
              <IconButton
                size="small"
                onClick={() => {
                  cancelSubmission();
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label={tCommon("clear")}
              >
                <HighlightOffIcon sx={{ fontSize: 22, color: "text.secondary" }} />
              </IconButton>
            ) : (
              !fullScreen && (
                <IconButton
                  type="submit"
                  size="small"
                  aria-label={t("searchAriaLabel")}
                  // Don't let the button steal focus from the input — otherwise
                  // the blur handler collapses the suggestions/AI card on click,
                  // unlike pressing Enter (which keeps focus). The click still submits.
                  onMouseDown={(e) => e.preventDefault()}
                  sx={{ display: { xs: "none", sm: "inline-flex" } }}
                >
                  <SearchIcon sx={{ fontSize: 22, color: "text.secondary" }} />
                </IconButton>
              )
            )}

            {!nearbyMode && (
              <Tooltip title={tCmd("open")} placement="bottom">
                <Box
                  component="kbd"
                  role="button"
                  tabIndex={0}
                  aria-label={tCmd("open")}
                  onClick={() => useCommandPaletteStore.getState().open()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      useCommandPaletteStore.getState().open();
                    }
                  }}
                  sx={(theme) => ({
                    display: { xs: "none", sm: "inline-flex" },
                    alignItems: "center",
                    fontFamily: "monospace",
                    fontSize: 11,
                    px: 0.75,
                    py: 0.25,
                    ml: 0.5,
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: 1,
                    color: "text.secondary",
                    cursor: "pointer",
                    userSelect: "none",
                    "&:hover": { bgcolor: "action.hover" },
                    "&:focus-visible": {
                      outline: `2px solid ${theme.palette.primary.main}`,
                      outlineOffset: 1,
                    },
                  })}
                >
                  {formatShortcut(PALETTE_SHORTCUT, shortcutPlatform)}
                </Box>
              </Tooltip>
            )}

            {!fullScreen &&
              !nearbyMode &&
              (hasSidePanel ? (
                <IconButton
                  size="small"
                  aria-label={t("closePanelAriaLabel")}
                  sx={{ ml: 1, mr: 0.5 }}
                  onClick={() => {
                    cancelSubmission();
                    closeSidePanel();
                    setQuery("");
                  }}
                >
                  <CloseIcon sx={{ fontSize: 22, color: "text.secondary" }} />
                </IconButton>
              ) : (
                <Tooltip title={t("directionsTooltip")} placement="bottom">
                  <IconButton
                    size="small"
                    aria-label={t("getDirectionsAriaLabel")}
                    sx={{ ml: 1, mr: 0.5 }}
                    onClick={() => {
                      cancelSubmission();
                      openDirections();
                      useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
                    }}
                  >
                    <DirectionsIcon sx={{ fontSize: 22, color: BRAND }} />
                  </IconButton>
                </Tooltip>
              ))}
            {/* Account avatar — inline in the search bar on mobile.
              The desktop equivalent is a separate floating control
              rendered by TopRightControls. Hidden when the search
              has expanded to fullscreen — it's not relevant
              while the user is typing a query. */}
            {!fullScreen && !nearbyMode && (
              <Box sx={{ display: { xs: "inline-flex", sm: "none" }, ml: 0.25, mr: 0.25 }}>
                <AccountAvatarButton size={32} />
              </Box>
            )}

            {/* Nearby pill — replaces the right-side controls while a place is
                anchored. The ✕ cancels the nearby search and reopens the place. */}
            {!fullScreen && nearbyMode && (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  bgcolor: BRAND,
                  color: "#fff",
                  borderRadius: 999,
                  ml: 1,
                  mr: 0.5,
                  pl: 1,
                  pr: 0.25,
                  height: 32,
                  flexShrink: 0,
                }}
              >
                <MyLocationIcon sx={{ fontSize: 18 }} />
                <Divider
                  orientation="vertical"
                  flexItem
                  sx={{ borderColor: "rgba(255,255,255,0.4)", mx: 0.5, my: 0.75 }}
                />
                <Tooltip title={t("cancelNearby")} placement="bottom">
                  <IconButton
                    size="small"
                    onClick={handleCancelNearby}
                    aria-label={t("cancelNearby")}
                    sx={{
                      color: "#fff",
                      p: 0.25,
                      "&:hover": { bgcolor: "rgba(255,255,255,0.15)" },
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            )}
          </Box>

          {/* Suggestions list — directly attached inside the same card.
            Skipped on mobile-fullscreen, where the dropdown is rendered as
            a full-width sibling panel below the bar (see end of return). */}
          {!fullScreen && showEmptySearch && (
            <>
              <Divider />
              <Box sx={{ maxHeight: 320, overflowY: "auto" }}>
                <SearchEmptyState
                  onSelectPlace={handleSelectLabeledPlace}
                  onSelectRecent={handleSelectRecent}
                  onClearRecent={handleClearRecent}
                />
              </Box>
            </>
          )}
          {!fullScreen && showDropdown && (
            <>
              <Divider />
              <Box
                sx={{
                  maxHeight: fullScreen ? "none" : 320,
                  flex: fullScreen ? 1 : "none",
                  minHeight: 0,
                  overflowY: "auto",
                }}
              >
                {nlpLoadingCard}
                {nlpCard}
                <AutocompleteDropdown
                  suggestions={effectiveSuggestions}
                  onSelect={handleSelectAny}
                  highlightedIndex={highlightedIndex}
                  onHighlight={highlightAt}
                  distanceReference={suggestionDistanceReference}
                  query={q}
                  idPrefix={listIdPrefix}
                />
                {visibleAttributions.length > 0 && (
                  <Box sx={{ display: "flex", justifyContent: "center", px: 1, py: 0.5 }}>
                    <AttributionStrip attributions={visibleAttributions} variant="inline" />
                  </Box>
                )}
              </Box>
            </>
          )}

          {/* Skeleton rows shown while the first results are loading */}
          {!fullScreen && showSkeleton && (
            <>
              <Divider />
              {[0, 1, 2].map((i) => (
                <Box
                  key={i}
                  sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.25 }}
                >
                  <Skeleton variant="circular" width={20} height={20} />
                  <Box sx={{ flex: 1 }}>
                    <Skeleton variant="text" width="55%" height={16} />
                    <Skeleton variant="text" width="35%" height={13} />
                  </Box>
                </Box>
              ))}
            </>
          )}
        </Paper>
      </Box>
      {/* Fullscreen results panel — only mounted on mobile while the bar
        is focused. Sits on top of the white backdrop, below the bar (with
        a small breathing gap), and fills the rest of the viewport. Empty
        query → labeled places; otherwise → autocomplete dropdown. */}
      {fullScreen && (
        <Box
          onFocusCapture={cancelBlur}
          onBlurCapture={handleBlur}
          sx={{
            position: "absolute",
            top: 72,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 13,
            overflowY: "auto",
            bgcolor: "background.paper",
          }}
        >
          {query.trim().length === 0 && !nearbyMode ? (
            <SearchEmptyState
              onSelectPlace={handleSelectLabeledPlace}
              onSelectRecent={handleSelectRecent}
              onClearRecent={handleClearRecent}
            />
          ) : showDropdown ? (
            <>
              {nlpLoadingCard}
              {nlpCard}
              <AutocompleteDropdown
                suggestions={effectiveSuggestions}
                onSelect={handleSelectAny}
                highlightedIndex={highlightedIndex}
                onHighlight={highlightAt}
                distanceReference={suggestionDistanceReference}
                query={q}
                idPrefix={listIdPrefix}
              />
              {visibleAttributions.length > 0 && (
                <Box sx={{ display: "flex", justifyContent: "center", px: 1, py: 1 }}>
                  <AttributionStrip attributions={visibleAttributions} variant="inline" />
                </Box>
              )}
            </>
          ) : showSkeleton ? (
            <Box>
              {[0, 1, 2].map((i) => (
                <Box
                  key={i}
                  sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.25 }}
                >
                  <Skeleton variant="circular" width={20} height={20} />
                  <Box sx={{ flex: 1 }}>
                    <Skeleton variant="text" width="55%" height={16} />
                    <Skeleton variant="text" width="35%" height={13} />
                  </Box>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )}
    </>
  );
}
