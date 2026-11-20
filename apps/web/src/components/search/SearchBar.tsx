"use client";

import Box from "@mui/material/Box";
import InputBase from "@mui/material/InputBase";
import type { Theme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { AutocompleteResult, LabeledPlace } from "@openmapx/core";
import {
  PANEL,
  useCategorySearchStore,
  useDataSourceStore,
  useDirectionsStore,
  useMapStore,
  usePlaceStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { SEARCH_INPUT_ID } from "@/components/command-palette/constants";
import { NlpConsentDialog } from "@/components/ui/NlpConsentDialog";
import { usePlaceEnrichment } from "@/hooks/usePlaceEnrichment";
import { useMap } from "@/integration-api/map/MapContext";
import { launchTextSearch } from "@/lib/launchExplore";
import { SEARCH_BAR_HEIGHT } from "@/lib/layout";
import { useBackDismiss } from "@/lib/useBackDismiss";
import { useRecentSearchStore } from "@/stores/recentSearchStore";
import { suggestionListboxId, suggestionOptionId } from "./AutocompleteDropdown";
import { exploreFromNearbyRow, applySearchAction as runSearchAction } from "./applySearchAction";
import { SearchBarLeading, SearchBarTrailing } from "./SearchBarControls";
import { SearchBarFrame } from "./SearchBarFrame";
import { FullScreenSearchResults, InlineSearchResults, searchVisibility } from "./SearchResults";
import { resolveLabeledPlaceAction, resolveSearchAction, type SearchAction } from "./searchAction";
import {
  useDelayedBlur,
  useNearbyAnchor,
  useStopSearchSession,
  useSubmitAfterFlush,
  useSuggestionKeyboard,
  useViewportSnapshot,
} from "./searchBarHooks";
import {
  captureViewport,
  finishSubmit,
  type SearchEnterContext,
  submitSearch,
} from "./searchEnter";
import type { NlpSubmissionContext, SearchBarSurface } from "./searchSubmission";
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

export function SearchBar({ surface = "map" }: SearchBarProps) {
  const t = useTranslations("search");
  const locale = useLocale();
  const isMobile = useMediaQuery<Theme>((theme) => theme.breakpoints.down("sm"));
  const query = useSearchStore((s) => s.query);
  const isFocused = useSearchStore((s) => s.isFocused);
  const { setQuery, setIsFocused } = useSearchStore.getState();
  const { selectWithEnrichment, cancelEnrichment } = usePlaceEnrichment();
  const directionsOpen = useDirectionsStore((s) => s.isOpen);
  const { flyTo, mapRef } = useMap();
  const userLocation = useMapStore((s) => s.userLocation);
  const inputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  // Nearby/Explore mode: a place is the anchor. Reuses this search bar, adding a
  // brand-coloured pill and routing selections to the place-anchored category search.
  const anchor = useNearbyAnchor(inputRef);
  const nearbyMode = anchor !== null;
  const { stopSearch, finish: finishStopSearch } = useStopSearchSession(inputRef);
  const submitAfterFlush = useSubmitAfterFlush(inputRef);
  const submission = useSearchSubmission({
    surface,
    query,
    locale,
    directionsOpen,
    cancelEnrichment,
    executeResolvedSubmit,
    captureViewport: () => captureViewport(mapRef.current),
    blurInput: () => inputRef.current?.blur(),
    searchText: (text) => launchTextSearch(mapRef.current, text),
  });
  const { cancelSubmission, nlp } = submission;
  const { cancelBlur, handleBlur } = useDelayedBlur(submission.cancelPending);

  const { mapCenter, mapZoom } = useViewportSnapshot(mapRef);
  const suggestions = useSuggestionRows({
    query,
    locale,
    // Rows are asked for only while someone can see them or an Enter waits on them.
    suggesting: isFocused || submission.pending,
    mapCenter,
    mapZoom,
    nearbyMode,
    stopSearch: stopSearch !== null,
  });
  const rows = suggestions.rows;
  const q = query.trim();
  const visible = searchVisibility({
    focused: isFocused,
    nearbyMode,
    stopSearch: stopSearch !== null,
    query: q,
    rows,
    fetching: suggestions.fetching,
    syntheticResult: suggestions.syntheticResult,
    nlpShowCard: nlp.showCard,
    nlpPending: nlp.pending,
  });
  const keyboard = useSuggestionKeyboard({
    rows,
    open: visible.showSuggestions,
    canReopen: q.length > 0,
    isComposing: () => isComposingRef.current,
    onEscape: () => {
      cancelSubmission();
      setIsFocused(false);
    },
    onReopen: () => setIsFocused(true),
    onChoose: (row) => handleSelectAny(row),
  });

  const { settled } = suggestions;
  const { settlePending } = submission;
  useEffect(() => {
    if (settled) settlePending();
  }, [settled, settlePending]);

  // Mobile: when the search is focused, the bar takes over the full viewport
  // Pure CSS transition — same component,same focus/dropdown state,
  // just a different layout.
  const fullScreen = isMobile && isFocused;

  const handleBack = () => {
    cancelSubmission();
    setIsFocused(false);
    inputRef.current?.blur();
    if (stopSearch) finishStopSearch();
  };
  // The full-screen search is a screen of its own on a phone; Back leaves it.
  useBackDismiss(fullScreen, handleBack);

  const updateQuery = (newValue: string) => {
    cancelSubmission();
    // In nearby mode keep the anchor (don't clearCategory — that would drop it);
    // the nearby dropdown re-filters and a selection relaunches the search.
    if (!nearbyMode) {
      // If user modifies the query while a category/data source is active, clear it
      const categories = useCategorySearchStore.getState();
      if (categories.activeCategory !== null) categories.clearCategory();
      const dataSources = useDataSourceStore.getState();
      if (dataSources.activeSource !== null) dataSources.setActiveSource(null);
    }
    keyboard.highlightRow(null);
    setQuery(newValue);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateQuery(e.target.value);
    // Typing again after Escape reopens the list.
    setIsFocused(true);
  };

  const handleVoiceResult = (transcript: string, isFinal: boolean) => {
    cancelSubmission();
    setQuery(transcript);
    if (isFinal) submitAfterFlush();
  };

  // A past search runs again, the same as typing it and pressing Enter.
  const handleSelectRecent = (recent: string) => {
    cancelBlur();
    updateQuery(recent);
    setIsFocused(true);
    inputRef.current?.focus();
    // Choosing a stop lists the matches to pick from instead of running the search.
    if (!stopSearch) submitAfterFlush();
  };

  const handleClearRecent = () => {
    cancelBlur();
    useRecentSearchStore.getState().clear();
    setIsFocused(true);
    inputRef.current?.focus();
  };

  const applySearchAction = (action: SearchAction) =>
    runSearchAction(action, {
      input: inputRef.current,
      mapRef,
      flyTo,
      selectWithEnrichment,
      stopSearch,
      finishStopSearch,
      runRecent: handleSelectRecent,
    });

  const handleSelect = (result: AutocompleteResult, recordHistory = true) => {
    cancelSubmission();
    applySearchAction(
      resolveSearchAction(result, {
        query: q,
        stopSearch: stopSearch !== null,
        recordHistory,
        dataSourceCategoryIds: suggestions.dataSourceCategories.map((category) => category.id),
      }),
    );
  };

  const enter: SearchEnterContext = {
    query,
    inputRef,
    mapRef,
    stopSearch: stopSearch !== null,
    anchor,
    rows,
    rankedSuggestions: suggestions.rankedSuggestions,
    syntheticResult: suggestions.syntheticResult,
    settled,
    mapCenter,
    mapZoom,
    geocodeQuery: suggestions.geocodeQuery,
    geocodeResults: suggestions.geocodeResults,
    beginSubmission: submission.beginSubmission,
    deferSubmission: submission.deferSubmission,
    runSubmission: submission.runSubmission,
    startNlp: submission.startNlp,
    select: handleSelect,
    apply: applySearchAction,
    chooseRow: (row) => {
      setIsFocused(true);
      keyboard.highlightRow(row);
    },
  };

  const handleSubmit = (e: React.FormEvent) => {
    // AuthDialog is portaled from the mobile account avatar inside this form.
    // React portal events follow the component tree, so its inner form's submit
    // reaches this handler unless we limit search handling to this form itself.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (!isComposingRef.current) submitSearch(enter);
  };

  function executeResolvedSubmit(nlpContext: NlpSubmissionContext) {
    finishSubmit(nlpContext, enter);
  }

  // Nearby mode: route a category pick / free-text to the place-anchored search.
  const handleNearbySelect = (result: AutocompleteResult) => {
    cancelSubmission();
    if (!anchor) return;
    setIsFocused(false);
    inputRef.current?.blur();
    exploreFromNearbyRow(result, anchor, q, mapRef.current);
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
    useCategorySearchStore.getState().clearCategory();
    setQuery("");
    setIsFocused(false);
    if (place) {
      usePlaceStore.getState().setSelectedPlace(place);
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
    }
  };

  const handleSelectLabeledPlace = (place: LabeledPlace) => {
    cancelSubmission();
    applySearchAction(resolveLabeledPlaceAction(place, stopSearch !== null));
  };

  if (directionsOpen && !stopSearch) return null;

  const listIdPrefix = OBSTRUCTION_ID[surface];
  const { highlightedIndex } = keyboard;
  const showDropdown = visible.showSuggestions;
  const showEmptySearch = visible.showEmpty;
  const nlpData = nlp.data;
  const results = {
    empty: {
      onSelectPlace: handleSelectLabeledPlace,
      onSelectRecent: handleSelectRecent,
      onClearRecent: handleClearRecent,
    },
    list: {
      rows,
      highlightedIndex,
      onHighlight: keyboard.highlightAt,
      onSelect: handleSelectAny,
      // Rows are measured from the person when located, else from the map centre.
      distanceReference: userLocation
        ? { kind: "user_location" as const, coordinates: userLocation }
        : mapCenter
          ? { kind: "search_area_center" as const, coordinates: mapCenter }
          : null,
      query: q,
      idPrefix: listIdPrefix,
      nlpCard:
        visible.showNlpCard && nlpData
          ? {
              intent: nlpData.intent,
              providerLabel: nlpData.providerLabel,
              onActivate: nlp.activate,
            }
          : null,
      nlpParsing: nlp.pending && !stopSearch,
    },
    showSuggestions: showDropdown,
    showSkeleton: visible.showSkeleton,
  };
  const placeholder = stopSearch
    ? stopSearch.placeholder
    : anchor
      ? t("searchNearbyName", { name: anchor.name })
      : t("placeholder");
  const activeOption = showDropdown && highlightedIndex >= 0;

  return (
    <>
      {!nearbyMode && nlp.showConsent && (
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
      <SearchBarFrame
        obstructionId={OBSTRUCTION_ID[surface]}
        onMap={surface === "map"}
        isMobile={isMobile}
        fullScreen={fullScreen}
        focused={isFocused}
        openBelow={showDropdown || showEmptySearch}
        onFocusCapture={cancelBlur}
        onBlurCapture={handleBlur}
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
          <SearchBarLeading fullScreen={fullScreen} isMobile={isMobile} onBack={handleBack} />
          <InputBase
            inputRef={inputRef}
            value={query}
            onChange={handleChange}
            onKeyDown={keyboard.handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onFocus={() => setIsFocused(true)}
            placeholder={placeholder}
            inputProps={{
              id: SEARCH_INPUT_ID,
              "aria-label": t("ariaLabel"),
              role: "combobox",
              "aria-autocomplete": "list",
              "aria-expanded": showDropdown,
              "aria-controls": showDropdown ? suggestionListboxId(listIdPrefix) : undefined,
              "aria-activedescendant": activeOption
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
          <SearchBarTrailing
            fullScreen={fullScreen}
            nearbyMode={nearbyMode}
            hasQuery={query.length > 0}
            onCancelSubmission={cancelSubmission}
            onClear={() => {
              cancelSubmission();
              setQuery("");
              inputRef.current?.focus();
            }}
            onCancelNearby={handleCancelNearby}
          />
        </Box>
        {/* Skipped on mobile-fullscreen, where the results are a full-width
            sibling panel below the bar. */}
        {!fullScreen && <InlineSearchResults showEmpty={showEmptySearch} {...results} />}
      </SearchBarFrame>
      {fullScreen && (
        <FullScreenSearchResults
          showEmpty={q.length === 0 && !nearbyMode}
          {...results}
          onFocusCapture={cancelBlur}
          onBlurCapture={handleBlur}
        />
      )}
    </>
  );
}
