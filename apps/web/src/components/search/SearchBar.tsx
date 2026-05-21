"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import DirectionsIcon from "@mui/icons-material/Directions";
import HighlightOffIcon from "@mui/icons-material/HighlightOff";
import MenuIcon from "@mui/icons-material/Menu";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
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
  isTransitRawCategory,
  PANEL,
  parseCoordinateInput,
  parseDMSCoordinateInput,
  parsePlusCodeInput,
  resolveStopAsPlace,
  useActiveSidePanel,
  useAdaptiveDebounce,
  useAirportSearch,
  useAutocomplete,
  useCapabilities,
  useCategorySearchStore,
  useChipTranslations,
  useCommandPaletteStore,
  useDataSourceStore,
  useDebounce,
  useDirectionsStore,
  useGeocoding,
  useLabeledPlaces,
  useMenuStore,
  usePlaceStore,
  usePresetSuggest,
  useSavedPlacesStore,
  useSearchStore,
  useSidebarStore,
  useStopSearch,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountAvatarButton } from "@/components/auth/AccountAvatarButton";
import { SEARCH_INPUT_ID } from "@/components/command-palette/constants";
import { useMap } from "@/lib/MapContext";
import { TEAL } from "@/lib/theme";
import { AutocompleteDropdown } from "./AutocompleteDropdown";
import { MobileSearchEmptyState } from "./MobileSearchEmptyState";

/** Pre-parsed once at module load — the shortcut never changes, no need to
 *  re-parse it on every SearchBar render. */
const PALETTE_SHORTCUT = parseShortcut("Mod+K");

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
  const tCmd = useTranslations("commandPalette");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const muiTheme = useTheme();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down("sm"));
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
  const [shortcutPlatform, setShortcutPlatform] = useState<ReturnType<typeof getPlatform>>("other");
  const debouncedQuery = useAdaptiveDebounce(query, 150, 50);
  const debouncedGeoQuery = useDebounce(query, 400);
  const { data: autocompleteData, isFetching } = useAutocomplete(debouncedQuery, locale);
  const { data: geocodeData } = useGeocoding(debouncedGeoQuery, locale);
  const { data: presetData } = usePresetSuggest(debouncedQuery, locale);
  const { data: airportSearchData } = useAirportSearch(debouncedQuery, 5);
  const { data: chipTranslations = {} } = useChipTranslations(locale);

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

  useEffect(() => {
    setShortcutPlatform(getPlatform());
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
    const lowerNormalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const poiMatches = CATEGORY_DEFINITIONS.filter((cat) => {
      if (cat.label.toLowerCase().includes(lower)) return true;
      const tr = chipTranslations[cat.id];
      if (!tr) return false;
      if (
        tr.name
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .includes(lowerNormalized)
      ) {
        return true;
      }
      return tr.terms.some((term) => term.includes(lowerNormalized));
    }).map((cat) => ({
      id: `category-${cat.id}`,
      label: chipTranslations[cat.id]?.name ?? cat.label,
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
  }, [q, t, dataSourceCategories, chipTranslations]);

  const presetSuggestions = useMemo<AutocompleteResult[]>(() => {
    return (presetData?.matches ?? []).map((p) => ({
      id: `category-preset:${p.id}`,
      label: p.name,
      sublabel: t("searchCategory"),
      type: "category" as const,
      presetIconKey: p.iconKey,
    }));
  }, [presetData, t]);

  // Airports — match the IATA / ICAO / name index loaded by knowledge-ourairports.
  // Surfaces results like "DUS — Düsseldorf Airport" alongside the geocoder.
  // Uses the `oa:` place-resolver scheme so selection drives straight to the
  // airport's full place panel (runways / frequencies / navaids) instead of a
  // coordinate-based reverse-geocode that may land on a building inside the
  // airport polygon.
  const airportSuggestions = useMemo<AutocompleteResult[]>(() => {
    return (airportSearchData?.matches ?? []).map((a) => {
      const codeBadge = a.iata ?? a.icao ?? a.ident;
      const labelPrefix = codeBadge ? `${codeBadge} — ` : "";
      const cityCountry = [a.municipality, a.isoCountry].filter(Boolean).join(", ");
      return {
        id: `oa:${a.ident}`,
        label: `${labelPrefix}${a.name}`,
        sublabel: cityCountry,
        coordinates: [a.lng, a.lat],
        type: "poi" as const,
        rawCategory: "aeroway/aerodrome",
        presetIconKey: "maki-airport",
      };
    });
  }, [airportSearchData]);

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
    // Client-side narrowing: keep items where every query token appears
    // somewhere in label or sublabel. Substring-only matching dropped real
    // hits like "Frankfurt am Main Airport ..." for the query "Frankfurt
    // Airport" because the tokens weren't contiguous.
    const narrowResults = (items: AutocompleteResult[]): AutocompleteResult[] => {
      if (q.length < 2 || items.length === 0) return items;
      const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      if (tokens.length === 0) return items;
      const filtered = items.filter((s) => {
        const hay = `${s.label} ${s.sublabel ?? ""}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
      return filtered.length > 0 ? filtered : items;
    };

    return (
      syntheticResult
        ? [syntheticResult]
        : [
            ...labeledSuggestions,
            ...categorySuggestions,
            ...presetSuggestions,
            ...airportSuggestions,
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
  }, [
    q,
    syntheticResult,
    labeledSuggestions,
    categorySuggestions,
    presetSuggestions,
    airportSuggestions,
    suggestions,
    stopSuggestions,
  ]);

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
      const firstPlace = createPlace({
        ...idsFromPrimaryOrCoords(first.id, first.coordinates),
        name: first.label,
        address: first.label,
        coordinates: first.coordinates,
        category: first.type,
        rawCategory: first.rawCategory,
      });
      if (first.rawCategory && isTransitRawCategory(first.rawCategory)) {
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
      const suggestionPlace = createPlace({
        ...idsFromPrimaryOrCoords(result.id, coords),
        name: result.label,
        address: result.sublabel ?? result.label,
        coordinates: coords,
        category: result.type,
        rawCategory: result.rawCategory,
      });
      // Route to a transit-stop lookup only when the geocoder itself classified
      // the result as transit infrastructure — never on a label-keyword match.
      if (result.rawCategory && isTransitRawCategory(result.rawCategory)) {
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

  // Mobile: when the search is focused, the bar takes over the full viewport
  // Pure CSS transition — same component,same focus/dropdown state,
  // just a different layout.
  const fullScreen = isMobile && isFocused;

  const handleBack = () => {
    setIsFocused(false);
    inputRef.current?.blur();
  };

  return (
    <>
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
        sx={{
          position: "absolute",
          top: "calc(12px + var(--omx-safe-top))",
          left: "calc(12px + var(--omx-safe-left))",
          right: {
            xs: "calc(12px + var(--omx-safe-right))",
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
            borderRadius: !fullScreen && showDropdown ? "24px 24px 16px 16px" : "24px",
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
              height: 48,
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
              onFocus={() => setIsFocused(true)}
              onBlur={handleBlur}
              placeholder={t("placeholder")}
              inputProps={{ id: SEARCH_INPUT_ID, "aria-label": t("ariaLabel") }}
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

            {fullScreen && query.length > 0 ? (
              <IconButton
                size="small"
                onClick={() => {
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
                  sx={{ display: { xs: "none", sm: "inline-flex" } }}
                >
                  <SearchIcon sx={{ fontSize: 22, color: "text.secondary" }} />
                </IconButton>
              )
            )}

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

            {!fullScreen &&
              (hasSidePanel ? (
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
              ))}

            {/* Account avatar — inline in the search bar on mobile.
              The desktop equivalent is a separate floating control
              rendered by TopRightControls. Hidden when the search
              has expanded to fullscreen — it's not relevant
              while the user is typing a query. */}
            {!fullScreen && (
              <Box sx={{ display: { xs: "inline-flex", sm: "none" }, ml: 0.25, mr: 0.25 }}>
                <AccountAvatarButton size={32} />
              </Box>
            )}
          </Box>

          {/* Suggestions list — directly attached inside the same card.
            Skipped on mobile-fullscreen, where the dropdown is rendered as
            a full-width sibling panel below the bar (see end of return). */}
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
          {query.trim().length === 0 ? (
            <MobileSearchEmptyState
              onSelectPlace={(p) => {
                setQuery(p.label);
                setIsFocused(false);
                flyTo([p.lng, p.lat], 15);
                setSelectedPlace(
                  createPlace({
                    ...idsFromPrimaryOrCoords(p.placeId ?? p.id, [p.lng, p.lat]),
                    name: p.name,
                    address: p.address ?? p.name,
                    coordinates: [p.lng, p.lat],
                  }),
                );
                useSidebarStore.getState().openSidebar(PANEL.PLACE);
              }}
            />
          ) : showDropdown ? (
            <>
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
                    p: 1,
                    textAlign: "center",
                    fontSize: 10.5,
                    "& a": { color: "text.secondary", textDecoration: "underline" },
                  }}
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted attribution HTML from geocoding provider
                  dangerouslySetInnerHTML={{ __html: geocodingAttribution }}
                />
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
