"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import DirectionsIcon from "@mui/icons-material/Directions";
import MenuIcon from "@mui/icons-material/Menu";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { AutocompleteResult, LngLat, TransitStop } from "@openmapx/core";
import {
  API_ENDPOINTS,
  apiClient,
  buildIntegrationAttribution,
  CATEGORY_DEFINITIONS,
  combineAttributions,
  coordinateId,
  createPlace,
  decodeShortPlusCode,
  detectShortPlusCodeCity,
  idsFromPrimaryOrCoords,
  isTransitName,
  PANEL,
  parseCoordinateInput,
  parseDMSCoordinateInput,
  parsePlusCodeInput,
  resolveStopAsPlace,
  useActiveSidePanel,
  useAdaptiveDebounce,
  useAutocomplete,
  useCapabilities,
  useCategorySearchStore,
  useDataSourceStore,
  useDebounce,
  useDirectionsStore,
  useGeocoding,
  useIntegrationRegistry,
  useLabeledPlaces,
  useMenuStore,
  usePlaceStore,
  useSavedPlacesStore,
  useSearchStore,
  useSidebarStore,
  useStopSearch,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";
import { TEAL } from "@/lib/theme";
import { AutocompleteDropdown } from "./AutocompleteDropdown";

/** Bigram set of a string. */
function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

/** Sørensen–Dice coefficient (0..1). */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bg1 = bigrams(a);
  const bg2 = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of bg1) {
    intersection += Math.min(count, bg2.get(bg) ?? 0);
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

/** Score a search result against the query (higher = more relevant). */
function searchRelevance(result: AutocompleteResult, query: string): number {
  const q = query.toLowerCase();
  const label = result.label.toLowerCase();

  // Dice similarity on full strings
  let score = diceSimilarity(q, label);

  // Prefix bonus: label starts with query
  if (label.startsWith(q)) {
    score += 0.4;
  } else if (label.includes(q)) {
    // Substring bonus (weaker)
    score += 0.15;
  }

  // Check sublabel too (e.g. "Berlin" might appear in address sublabel)
  if (result.sublabel) {
    const sub = result.sublabel.toLowerCase();
    if (sub.includes(q)) score += 0.05;
  }

  // Labeled places (Home, Work, custom) get a strong boost to appear near the top
  if (result.type === "labeled_place") score += 0.5;

  return score;
}

const MODE_LABEL_KEYS: Record<string, string> = {
  bus: "bus",
  rail: "rail",
  subway: "subway",
  tram: "tram",
  ferry: "ferry",
  gondola: "gondola",
  funicular: "funicular",
  cable_car: "cableCar",
  monorail: "monorail",
  walking: "walking",
};

export function SearchBar() {
  const t = useTranslations("search");
  const tModes = useTranslations("searchModes");
  const tSaved = useTranslations("saved");
  const locale = useLocale();
  const { query, isFocused, suggestions, setQuery, setIsFocused, setSuggestions, setResults } =
    useSearchStore();
  const { setSelectedPlace } = usePlaceStore();
  const { isOpen: hasSidePanel, close: closeSidePanel } = useActiveSidePanel();
  const { isOpen: directionsOpen, open: openDirections } = useDirectionsStore();
  const { activeCategory, setActiveCategory, clearCategory } = useCategorySearchStore();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const setActiveSource = useDataSourceStore((s) => s.setActiveSource);
  const openMenu = useMenuStore((s) => s.open);
  const { selectedListId, clearSelectedList } = useSavedPlacesStore();
  const { flyTo, mapRef } = useMap();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debouncedQuery = useAdaptiveDebounce(query, 150, 50);
  const debouncedGeoQuery = useDebounce(query, 400);
  const { data: autocompleteData, isFetching } = useAutocomplete(debouncedQuery, locale);
  const { data: geocodeData } = useGeocoding(debouncedGeoQuery, locale);

  // Stop search — slower debounce to reduce transit API load
  const rawStopQuery = query.trim().length >= 2 ? query.trim() : "";
  const debouncedStopQuery = useDebounce(rawStopQuery, 750);
  const { data: stopSearchData } = useStopSearch(debouncedStopQuery);

  // Labeled places (Home, Work, custom) for search suggestions
  const { data: labeledPlaces } = useLabeledPlaces();

  // Data source categories from integration manifests
  const registry = useIntegrationRegistry();
  const dataSourceCategories = useMemo(() => {
    const withSearchCat = registry.getWithSearchCategory();
    return withSearchCat
      .map((i) => {
        const sc = i.frontend?.searchCategory as
          | { id: string; label?: string; iconPath?: string }
          | undefined;
        if (!sc) return null;
        return { id: sc.id, label: sc.label ?? sc.id, iconPath: sc.iconPath, integrationId: i.id };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [registry]);

  // Geocoding attribution — only show providers that are available and healthy
  const { services: caps } = useCapabilities();
  const geocodingAttribution = useMemo(() => {
    const geocoders = registry.getByDomain("geocoding").filter((g) => {
      const cap = caps[g.id];
      return cap ? cap.available && cap.healthy : false;
    });
    if (geocoders.length === 0) return "";
    return combineAttributions(
      geocoders.map((g) => buildIntegrationAttribution(g.dataSources)).filter(Boolean),
    );
  }, [registry, caps]);

  // Clean up blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    };
  }, []);

  const handleBlur = useCallback(() => {
    blurTimeoutRef.current = setTimeout(() => setIsFocused(false), 150);
  }, [setIsFocused]);

  // When user types a short plus code with city, geocode the city name to get
  // the reference coordinates for decoding.
  const shortPlusCity = detectShortPlusCodeCity(query.trim());
  const debouncedCity = useDebounce(shortPlusCity?.city ?? "", 400);
  const { data: cityRefData } = useGeocoding(debouncedCity, locale);

  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggestions([]);
      queryClient.removeQueries({ queryKey: ["autocomplete"] });
    } else {
      setSuggestions(autocompleteData ?? []);
    }
    setHighlightedIndex(-1);
  }, [autocompleteData, query, queryClient, setSuggestions]);

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
      if (!parsed) {
        const raw = mapRef.current?.getCenter();
        const mapCenter: LngLat | undefined = raw ? [raw.lng, raw.lat] : undefined;
        parsed = parsePlusCodeInput(q, mapCenter);
      }
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

  // Inject matching category suggestions at the top of the dropdown
  // Merges POI categories (hardcoded) with data source categories (from manifests)
  const categorySuggestions = useMemo<AutocompleteResult[]>(() => {
    if (q.length < 1) return [];
    const lower = q.toLowerCase();
    const poiMatches = CATEGORY_DEFINITIONS.filter((cat) =>
      cat.label.toLowerCase().includes(lower),
    ).map((cat) => ({
      id: `category-${cat.id}`,
      label: cat.label,
      sublabel: t("searchCategory"),
      type: "category" as const,
      iconPath: cat.iconPath,
    }));
    const dsMatches = dataSourceCategories
      .filter((ds) => ds.label.toLowerCase().includes(lower))
      .map((ds) => ({
        id: `category-${ds.id}`,
        label: ds.label,
        sublabel: t("searchCategory"),
        type: "category" as const,
        iconPath: ds.iconPath,
      }));
    return [...dsMatches, ...poiMatches];
  }, [q, t, dataSourceCategories]);

  const stopSuggestions = useMemo<AutocompleteResult[]>(
    () =>
      (stopSearchData ?? []).map(
        (stop): AutocompleteResult => ({
          id: `stop-${stop.id}`,
          label: stop.name,
          sublabel: stop.modes
            .map((m) => (MODE_LABEL_KEYS[m] ? tModes(MODE_LABEL_KEYS[m]) : m))
            .join(", "),
          coordinates: [stop.lng, stop.lat],
          type: "transit_stop",
          transitStop: stop,
        }),
      ),
    [stopSearchData, tModes],
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

  const displaySuggestions = useMemo(() => {
    // Client-side prefix narrowing
    const narrowResults = (items: AutocompleteResult[]): AutocompleteResult[] => {
      if (q.length < 2 || items.length === 0) return items;
      const ql = q.toLowerCase();
      const filtered = items.filter((s) => {
        const label = s.label.toLowerCase();
        const sub = (s.sublabel ?? "").toLowerCase();
        return label.includes(ql) || sub.includes(ql);
      });
      return filtered.length > 0 ? filtered : items;
    };

    return (
      syntheticResult
        ? [syntheticResult]
        : [
            ...labeledSuggestions,
            ...categorySuggestions,
            ...narrowResults(suggestions),
            ...narrowResults(stopSuggestions).slice(0, 3),
          ].sort((a, b) => searchRelevance(b, q) - searchRelevance(a, q))
    ).filter(
      (s, i, arr) =>
        arr.findIndex((x) => {
          if (x.label !== s.label || (x.sublabel ?? "") !== (s.sublabel ?? "")) return false;
          if (!x.coordinates || !s.coordinates) return x.id === s.id;
          const dlng = x.coordinates[0] - s.coordinates[0];
          const dlat = x.coordinates[1] - s.coordinates[1];
          return dlng * dlng + dlat * dlat < 0.0001; // ~1 km
        }) === i,
    );
  }, [q, syntheticResult, labeledSuggestions, categorySuggestions, suggestions, stopSuggestions]);

  if (directionsOpen) return null;

  const showDropdown = isFocused && displaySuggestions.length > 0;

  const tryOpenTransitStop = async (coords: LngLat, name: string): Promise<boolean> => {
    try {
      const delta = 0.005; // ~500m
      const stops = await apiClient.get<TransitStop[]>(API_ENDPOINTS.transitStops, {
        sw_lat: String(coords[1] - delta),
        sw_lng: String(coords[0] - delta),
        ne_lat: String(coords[1] + delta),
        ne_lng: String(coords[0] + delta),
      });
      // Find closest stop with matching name (fuzzy)
      const match = stops.find(
        (s) =>
          s.name.toLowerCase().includes(name.toLowerCase().slice(0, 10)) ||
          name.toLowerCase().includes(s.name.toLowerCase().slice(0, 10)),
      );
      if (match) {
        // Reuse the shared synthetic-stop builder so the Place picks up
        // the provider-scoped scheme (tfl, mb, dyn, …) from the stop id.
        void resolveStopAsPlace(match).then((place) => {
          setSelectedPlace(place);
          useSidebarStore.getState().openSidebar(PANEL.PLACE);
        });
        return true;
      }
    } catch {
      // Silently fall back to place panel
    }
    return false;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown) return;
    const count = displaySuggestions.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev < count - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : count - 1));
    } else if (e.key === "Enter" && highlightedIndex >= 0) {
      e.preventDefault();
      handleSelect(displaySuggestions[highlightedIndex]);
    } else if (e.key === "Escape") {
      setIsFocused(false);
      setHighlightedIndex(-1);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    // If user modifies the query while a category/data source is active, clear it
    if (activeCategory !== null) {
      clearCategory();
    }
    if (activeSource !== null) {
      setActiveSource(null);
    }
    setQuery(newValue);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    inputRef.current?.blur();
    if (syntheticResult) {
      handleSelect(syntheticResult);
      return;
    }
    const first = geocodeData?.[0];
    if (first) {
      flyTo(first.coordinates, 15);
      const text = first.label.toLowerCase();
      const firstPlace = createPlace({
        ...idsFromPrimaryOrCoords(first.id, first.coordinates),
        name: first.label,
        address: first.label,
        coordinates: first.coordinates,
        category: first.type,
        rawCategory: first.rawCategory,
      });
      if (isTransitName(text)) {
        void tryOpenTransitStop(first.coordinates, first.label).then((found) => {
          if (!found) {
            setSelectedPlace(firstPlace);
            useSidebarStore.getState().openSidebar(PANEL.PLACE);
          }
        });
      } else {
        setSelectedPlace(firstPlace);
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      }
    }
  };

  const handleSelect = (result: AutocompleteResult) => {
    if (result.type === "labeled_place" && result.coordinates) {
      setQuery(result.label);
      setIsFocused(false);
      flyTo(result.coordinates, 15);
      setSelectedPlace(
        createPlace({
          ...idsFromPrimaryOrCoords(result.id, result.coordinates),
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
      void resolveStopAsPlace(result.transitStop).then((place) => {
        setSelectedPlace(place);
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      });
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
      flyTo(coords, 15);
      // Try to open as transit stop
      const text = `${result.label} ${result.sublabel ?? ""}`.toLowerCase();
      const suggestionPlace = createPlace({
        ...idsFromPrimaryOrCoords(result.id, coords),
        name: result.label,
        address: result.sublabel ?? result.label,
        coordinates: coords,
        category: result.type,
        rawCategory: result.rawCategory,
      });
      if (isTransitName(text)) {
        void tryOpenTransitStop(coords, result.label).then((found) => {
          if (!found) {
            setSelectedPlace(suggestionPlace);
            useSidebarStore.getState().openSidebar(PANEL.PLACE);
          }
        });
      } else {
        setSelectedPlace(suggestionPlace);
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      }
    }
  };

  const showSkeleton =
    isFocused && query.trim().length >= 2 && isFetching && !showDropdown && !syntheticResult;

  return (
    <Box
      sx={{
        position: "absolute",
        top: 12,
        left: 12,
        zIndex: 10,
        width: { xs: "calc(100% - 110px)", sm: "auto" },
      }}
    >
      <Paper
        elevation={isFocused ? 4 : 2}
        sx={{
          width: { xs: "100%", sm: 376 },
          borderRadius: showDropdown ? "24px 24px 16px 16px" : "24px",
          overflow: "hidden",
          transition: "box-shadow 0.2s, border-radius 0.15s",
          bgcolor: "background.paper",
        }}
      >
        {/* Search input row */}
        <Box
          component="form"
          onSubmit={handleSubmit}
          sx={{ display: "flex", alignItems: "center", height: 48, px: 0.5 }}
        >
          {selectedListId ? (
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
            onFocus={() => setIsFocused(true)}
            onBlur={handleBlur}
            placeholder={t("placeholder")}
            inputProps={{ "aria-label": t("ariaLabel") }}
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

          <IconButton type="submit" size="small" aria-label={t("searchAriaLabel")}>
            <SearchIcon sx={{ fontSize: 22, color: "text.secondary" }} />
          </IconButton>

          {hasSidePanel ? (
            <IconButton
              size="small"
              aria-label={t("closePanelAriaLabel")}
              sx={{ ml: 1, mr: 0.5 }}
              onClick={() => {
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
                  openDirections();
                  useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
                }}
              >
                <DirectionsIcon sx={{ fontSize: 22, color: TEAL }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>

        {/* Suggestions list — directly attached inside the same card */}
        {showDropdown && (
          <>
            <Divider />
            <Box sx={{ maxHeight: 320, overflowY: "auto" }}>
              <AutocompleteDropdown
                suggestions={displaySuggestions}
                onSelect={handleSelect}
                highlightedIndex={highlightedIndex}
              />
              {geocodingAttribution && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    display: "block",
                    p: 0.5,
                    textAlign: "center",
                    fontSize: 10.5,
                    "& a": { color: "text.secondary", textDecoration: "underline" },
                  }}
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted attribution HTML from geocoding provider
                  dangerouslySetInnerHTML={{ __html: geocodingAttribution }}
                />
              )}
            </Box>
          </>
        )}

        {/* Skeleton rows shown while the first results are loading */}
        {showSkeleton && (
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
  );
}
