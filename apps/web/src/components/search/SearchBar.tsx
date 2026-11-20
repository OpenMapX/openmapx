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
import type {
  AutocompleteResult,
  CategoryId,
  DistanceReference,
  LabeledPlace,
  LngLat,
} from "@openmapx/core";
import {
  brandToFilter,
  makeSyntheticStopPlace,
  PANEL,
  resolveStopAsPlace,
  useActiveSidePanel,
  useCategorySearchStore,
  useDataSourceStore,
  useDirectionsStore,
  useMapStore,
  useMenuStore,
  usePlaceStore,
  useSavedPlacesStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
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
import {
  SEARCH_BAR_CLEARANCE,
  SEARCH_BAR_HEIGHT,
  SEARCH_BAR_INSET,
  SEARCH_BAR_TOP,
} from "@/lib/layout";
import { useMeasuredMapObstruction } from "@/lib/mapObstructions";
import { servedAttributions } from "@/lib/servedAttributions";
import { useBackDismiss } from "@/lib/useBackDismiss";
import { useRecentSearchStore } from "@/stores/recentSearchStore";
import { useStopSearchStore } from "@/stores/stopSearchStore";
import {
  AutocompleteDropdown,
  suggestionListboxId,
  suggestionOptionId,
} from "./AutocompleteDropdown";
import { NlpSearchCard } from "./NlpSearchCard";
import { SearchEmptyState } from "./SearchEmptyState";
import {
  findTransitStopPlace,
  resolveGeocodeAction,
  resolveLabeledPlaceAction,
  resolveSearchAction,
  type SearchAction,
} from "./searchAction";
import {
  decideSearchSubmission,
  type NlpSubmissionContext,
  type SearchBarSurface,
} from "./searchSubmission";
import { useSearchSubmission } from "./useSearchSubmission";
import { useSuggestionRows } from "./useSuggestionRows";
import { VoiceSearchButton } from "./VoiceSearchButton";

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

export function SearchBar({ surface = "map" }: SearchBarProps) {
  const t = useTranslations("search");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const muiTheme = useTheme();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const query = useSearchStore((s) => s.query);
  const isFocused = useSearchStore((s) => s.isFocused);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setIsFocused = useSearchStore((s) => s.setIsFocused);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const { selectWithEnrichment, cancelEnrichment } = usePlaceEnrichment();
  const { isOpen: hasSidePanel, close: closeSidePanel } = useActiveSidePanel();
  const sidebarCollapsed = useSidebarStore((s) => s.collapsed);
  const docked = !isMobile && hasSidePanel && !sidebarCollapsed && !isFocused;
  const directionsOpen = useDirectionsStore((s) => s.isOpen);
  const openDirections = useDirectionsStore((s) => s.open);
  // Phone directions borrow this search to choose a trip stop.
  const stopSearch = useStopSearchStore((s) => s.request);
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
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const clearSelectedList = useSavedPlacesStore((s) => s.clearSelectedList);
  const { flyTo, mapRef } = useMap();
  const userLocation = useMapStore((s) => s.userLocation);
  const registry = useIntegrationRegistry();
  const inputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keyed by row rather than position, so rows arriving late cannot slide a
  // different place under the highlight.
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const [barEl, setBarEl] = useState<HTMLDivElement | null>(null);
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
  const {
    rows: effectiveSuggestions,
    rankedSuggestions,
    syntheticResult,
    dataSourceCategories,
    fetching: suggestionsFetching,
    settled: suggestionsSettled,
    geocodeQuery,
    geocodeResults,
  } = useSuggestionRows({
    query,
    locale,
    // Rows are asked for only while someone can see them or an Enter waits on them.
    suggesting: isFocused || pending,
    mapCenter,
    mapZoom,
    nearbyMode,
    stopSearch: stopSearch !== null,
  });
  const q = query.trim();

  const suggestionDistanceReference: DistanceReference | null = userLocation
    ? { kind: "user_location", coordinates: userLocation }
    : mapCenter
      ? { kind: "search_area_center", coordinates: mapCenter }
      : null;
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

  // Mobile: when the search is focused, the bar takes over the full viewport
  // Pure CSS transition — same component,same focus/dropdown state,
  // just a different layout.
  const fullScreen = isMobile && isFocused;

  const finishStopSearch = () => {
    setQuery("");
    setIsFocused(false);
    useStopSearchStore.getState().close();
  };

  const handleBack = () => {
    cancelSubmission();
    setIsFocused(false);
    inputRef.current?.blur();
    if (stopSearch) finishStopSearch();
  };
  // The full-screen search is a screen of its own on a phone; Back leaves it.
  useBackDismiss(fullScreen, handleBack);

  // Desktop keeps the bar inside the rail's column, which is already registered
  // as an obstruction; a full-screen search covers the map entirely, and
  // framing against that would leave nothing to aim at. The street-level viewer
  // covers it just as completely, so the bar riding on it registers nothing.
  useMeasuredMapObstruction(
    OBSTRUCTION_ID[surface],
    "top",
    surface === "map" && isMobile && !fullScreen ? barEl : null,
  );

  const listIdPrefix = OBSTRUCTION_ID[surface];
  const highlightedIndex =
    highlightedKey === null
      ? -1
      : effectiveSuggestions.findIndex((row) => rowKey(row) === highlightedKey);

  useEffect(() => {
    if (suggestionsSettled) settlePending();
  }, [suggestionsSettled, settlePending]);

  useEffect(() => {
    if (directionsOpen) cancelEnrichment();
  }, [directionsOpen, cancelEnrichment]);

  // A stop search starts from the stop's text in the full-screen search, and
  // ends whenever that search closes, however it is left.
  const stopSearchShownRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once per request
  useEffect(() => {
    stopSearchShownRef.current = false;
    if (!stopSearch) return;
    setQuery(stopSearch.initialQuery);
    setIsFocused(true);
    inputRef.current?.focus();
  }, [stopSearch]);
  useEffect(() => {
    if (!stopSearch) return;
    if (isFocused) stopSearchShownRef.current = true;
    else if (stopSearchShownRef.current) useStopSearchStore.getState().close();
  }, [stopSearch, isFocused]);

  if (directionsOpen && !stopSearch) return null;

  // Attribution follows the visible ranked rows, not the response envelope.
  const visibleAttributions = servedAttributions(registry, effectiveSuggestions);
  const nlpData = nlp.data;
  const showNlpCard = !nearbyMode && !stopSearch && nlp.showCard;
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
  const nlpLoadingCard =
    nlpPending && !stopSearch ? (
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
    suggestionsFetching && effectiveSuggestions.every((row) => row.type === "text_search");
  const showDropdown =
    isFocused &&
    ((effectiveSuggestions.length > 0 && !awaitingFirstRows) || showNlpCard || nlpPending);
  const showEmptySearch = isFocused && !nearbyMode && q.length === 0;

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
    // Choosing a stop lists the matches to pick from instead of running the search.
    if (!stopSearch) setSubmitAfterFlush(true);
  };

  const handleClearRecent = () => {
    if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    clearRecentSearches();
    setIsFocused(true);
    inputRef.current?.focus();
  };

  /** Carries out what a selection resolved to: the box, the history, the map and the panel. */
  const applySearchAction = (action: SearchAction) => {
    switch (action.kind) {
      case "none":
        return;
      case "pick-stop":
        stopSearch?.onPick({ coordinates: action.coordinates, label: action.label });
        finishStopSearch();
        return;
      case "run-recent":
        handleSelectRecent(action.text);
        return;
      case "search-area":
        addRecentSearch(action.text);
        setIsFocused(false);
        inputRef.current?.blur();
        launchTextSearch(mapRef.current, action.text);
        return;
      case "select":
        break;
    }
    if (action.history) {
      addRecentSearch(action.history.search);
      useRecentSearchStore.getState().addDestination(action.history.destination);
    }
    const closeWith = (text: string | null) => {
      if (text === null) return;
      setQuery(text);
      setIsFocused(false);
    };
    const { target } = action;
    switch (target.kind) {
      case "place":
      case "stop":
      case "none":
        closeWith(action.query);
        if (action.query === null) inputRef.current?.blur();
        break;
    }
    switch (target.kind) {
      case "place":
        if (target.flyTo) flyTo(target.flyTo, 15);
        if (target.transitLookup) {
          const { coordinates, name } = target.transitLookup;
          selectWithEnrichment(target.place, (isCurrent) =>
            findTransitStopPlace(coordinates, name, isCurrent),
          );
        } else {
          setSelectedPlace(target.place);
        }
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
        return;
      case "stop": {
        const { stop } = target;
        if (target.flyTo) flyTo(target.flyTo, 15);
        selectWithEnrichment(makeSyntheticStopPlace(stop), () => resolveStopAsPlace(stop));
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
        return;
      }
      case "brand":
        setBrandFilter(target.brand, brandToFilter(target.brand));
        useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
        closeWith(action.query);
        return;
      case "data-source":
        clearCategory();
        setActiveSource(target.sourceId);
        useSidebarStore.getState().openSidebar(PANEL.DATASOURCE);
        closeWith(action.query);
        return;
      case "category":
        setActiveCategory(target.categoryId);
        useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
        closeWith(action.query);
        return;
      case "none":
        return;
    }
  };

  const handleSelect = (result: AutocompleteResult, recordHistory = true) => {
    cancelSubmission();
    applySearchAction(
      resolveSearchAction(result, {
        query: q,
        stopSearch: stopSearch !== null,
        recordHistory,
        dataSourceCategoryIds: dataSourceCategories.map((category) => category.id),
      }),
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    // AuthDialog is portaled from the mobile account avatar inside this form.
    // React portal events follow the component tree, so its inner form's submit
    // reaches this handler unless we limit search handling to this form itself.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (isComposingRef.current || !q) return;
    if (stopSearch) {
      const first = effectiveSuggestions[0];
      if (first) handleSelect(first);
      return;
    }
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
      geocodeQuery,
      geocodeResults,
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
      applySearchAction(resolveGeocodeAction(action.result, action.address, action.isTransit));
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
    q.length >= 2 &&
    suggestionsFetching &&
    !showDropdown &&
    !syntheticResult;

  const handleSelectLabeledPlace = (place: LabeledPlace) => {
    cancelSubmission();
    applySearchAction(resolveLabeledPlaceAction(place, stopSearch !== null));
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
          top: SEARCH_BAR_TOP,
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
          elevation={fullScreen || docked ? 0 : isFocused ? 4 : 2}
          sx={{
            width: { xs: "100%", sm: 376 },
            // Over the open side panel the bar is part of the panel: an outline
            // instead of a shadow, which would float it above its own surface.
            outline: docked ? "1px solid var(--omx-border-light)" : "none",
            outlineOffset: -1,
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
              <IconButton
                size="small"
                sx={{ ml: 0.5, mr: 0.5 }}
                onClick={clearSelectedList}
                aria-label={tCommon("back")}
              >
                <ArrowBackIcon sx={{ fontSize: 22, color: "text.secondary" }} />
              </IconButton>
            ) : isMobile ? (
              // On a phone the avatar opens the one menu, so the field
              // starts with its own glyph instead of a second menu button.
              <SearchIcon
                aria-hidden
                sx={{ fontSize: 22, color: "text.secondary", ml: 1.25, mr: 0.75, flexShrink: 0 }}
              />
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
                stopSearch
                  ? stopSearch.placeholder
                  : nearbyMode && anchor
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
                <AccountAvatarButton size={32} onOpen={openMenu} openLabel={t("menuAriaLabel")} />
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
            // Below the bar, which itself sits below the top safe area. Inside
            // the installed app the page draws under the status bar, so a
            // fixed offset would put the results over the search input.
            top: SEARCH_BAR_CLEARANCE,
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
