"use client";

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
import type { AutocompleteResult, LngLat, TransitStop } from "@openmapx/core";
import {
  API_ENDPOINTS,
  apiClient,
  CATEGORY_DEFINITIONS,
  decodeShortPlusCode,
  detectShortPlusCodeCity,
  isTransitName,
  parseCoordinateInput,
  parseDMSCoordinateInput,
  parsePlusCodeInput,
  useActiveSidePanel,
  useAutocomplete,
  useCategorySearchStore,
  useDataSourceStore,
  useDebounce,
  useDirectionsStore,
  useGeocoding,
  usePlaceStore,
  useSearchStore,
  useStopSearch,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { resolveStopAsPlace } from "@/lib/geocodeStopAsPlace";
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

  return score;
}

const MODE_LABELS: Record<string, string> = {
  bus: "Bus",
  rail: "Train",
  subway: "Subway",
  tram: "Tram",
  ferry: "Ferry",
  gondola: "Gondola",
  funicular: "Funicular",
  cable_car: "Cable Car",
  monorail: "Monorail",
  walking: "Walking",
};

export function SearchBar() {
  const { query, isFocused, suggestions, setQuery, setIsFocused, setSuggestions, setResults } =
    useSearchStore();
  const { setSelectedPlace } = usePlaceStore();
  const { isOpen: hasSidePanel, close: closeSidePanel } = useActiveSidePanel();
  const { isOpen: directionsOpen, open: openDirections } = useDirectionsStore();
  const { activeCategory, setActiveCategory, clearCategory } = useCategorySearchStore();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const setActiveSource = useDataSourceStore((s) => s.setActiveSource);
  const { flyTo, mapRef } = useMap();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedQuery = useDebounce(query, 300);
  const debouncedGeoQuery = useDebounce(query, 400);
  const { data: autocompleteData, isFetching } = useAutocomplete(debouncedQuery);
  const { data: geocodeData } = useGeocoding(debouncedGeoQuery);

  // Stop search — slower debounce to reduce transit API load
  const rawStopQuery = query.trim().length >= 2 ? query.trim() : "";
  const debouncedStopQuery = useDebounce(rawStopQuery, 750);
  const { data: stopSearchData } = useStopSearch(debouncedStopQuery);

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
  const { data: cityRefData } = useGeocoding(debouncedCity);

  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggestions([]);
      queryClient.removeQueries({ queryKey: ["autocomplete"] });
    } else {
      setSuggestions(autocompleteData ?? []);
    }
  }, [autocompleteData, query, queryClient, setSuggestions]);

  useEffect(() => {
    setResults(geocodeData ?? []);
  }, [geocodeData, setResults]);

  if (directionsOpen) return null;

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
        id: `coordinate-${parsed.lngLat[1].toFixed(6)}-${parsed.lngLat[0].toFixed(6)}`,
        label: parsed.label,
        coordinates: parsed.lngLat,
        type: "address",
      };
    }
  }

  // Inject matching category suggestions at the top of the dropdown
  const categorySuggestions: AutocompleteResult[] =
    q.length >= 1
      ? CATEGORY_DEFINITIONS.filter((cat) => cat.label.toLowerCase().includes(q.toLowerCase())).map(
          (cat) => ({
            id: `category-${cat.id}`,
            label: cat.label,
            sublabel: "Search category",
            type: "category" as const,
            iconPath: cat.iconPath,
          }),
        )
      : [];

  const stopSuggestions: AutocompleteResult[] = (stopSearchData ?? []).map(
    (stop): AutocompleteResult => ({
      id: `stop-${stop.id}`,
      label: stop.name,
      sublabel: stop.modes.map((m) => MODE_LABELS[m] ?? m).join(", "),
      coordinates: [stop.lng, stop.lat],
      type: "transit_stop",
      transitStop: stop,
    }),
  );

  const displaySuggestions = syntheticResult
    ? [syntheticResult]
    : [...categorySuggestions, ...suggestions, ...stopSuggestions.slice(0, 3)].sort(
        (a, b) => searchRelevance(b, q) - searchRelevance(a, q),
      );

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
        setSelectedPlace({
          id: `stop:${match.id}`,
          name: match.name,
          address: match.name,
          coordinates: [match.lng, match.lat] as [number, number],
        });
        return true;
      }
    } catch {
      // Silently fall back to PlacePanel
    }
    return false;
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
      if (isTransitName(text)) {
        void tryOpenTransitStop(first.coordinates, first.label).then((found) => {
          if (!found) {
            setSelectedPlace({
              id: first.id,
              name: first.label,
              address: first.label,
              coordinates: first.coordinates,
              category: first.type,
              rawCategory: first.rawCategory,
            });
          }
        });
      } else {
        setSelectedPlace({
          id: first.id,
          name: first.label,
          address: first.label,
          coordinates: first.coordinates,
          category: first.type,
          rawCategory: first.rawCategory,
        });
      }
    }
  };

  const handleSelect = (result: AutocompleteResult) => {
    if (result.type === "transit_stop" && result.transitStop) {
      setQuery(result.label);
      setIsFocused(false);
      if (result.coordinates) flyTo(result.coordinates, 15);
      void resolveStopAsPlace(result.transitStop).then(setSelectedPlace);
      return;
    }

    if (result.type === "category") {
      // Extract category id from the synthetic id ("category-restaurants" → "restaurants")
      const catId = result.id.replace("category-", "");
      const def = CATEGORY_DEFINITIONS.find((c) => c.id === catId);
      if (def?.dataSourceId) {
        // Route to data source system instead of category search
        clearCategory();
        setActiveSource(def.dataSourceId);
      } else {
        setActiveCategory(catId as Parameters<typeof setActiveCategory>[0]);
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
      if (isTransitName(text)) {
        void tryOpenTransitStop(coords, result.label).then((found) => {
          if (!found) {
            setSelectedPlace({
              id: result.id,
              name: result.label,
              address: result.sublabel ?? result.label,
              coordinates: coords,
              category: result.type,
              rawCategory: result.rawCategory,
            });
          }
        });
      } else {
        setSelectedPlace({
          id: result.id,
          name: result.label,
          address: result.sublabel ?? result.label,
          coordinates: result.coordinates,
          category: result.type,
          rawCategory: result.rawCategory,
        });
      }
    }
  };

  const showDropdown = isFocused && displaySuggestions.length > 0;
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
          <IconButton size="small" sx={{ ml: 0.5, mr: 0.5 }} aria-label="Menu">
            <MenuIcon sx={{ fontSize: 22, color: "text.secondary" }} />
          </IconButton>

          <InputBase
            inputRef={inputRef}
            value={query}
            onChange={handleChange}
            onFocus={() => setIsFocused(true)}
            onBlur={handleBlur}
            placeholder="Search OpenMapX"
            inputProps={{ "aria-label": "search" }}
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

          <IconButton type="submit" size="small" aria-label="Search">
            <SearchIcon sx={{ fontSize: 22, color: "text.secondary" }} />
          </IconButton>

          {hasSidePanel ? (
            <IconButton
              size="small"
              aria-label="Close panel"
              sx={{ ml: 1, mr: 0.5 }}
              onClick={() => {
                closeSidePanel();
                setQuery("");
              }}
            >
              <CloseIcon sx={{ fontSize: 22, color: "text.secondary" }} />
            </IconButton>
          ) : (
            <Tooltip title="Directions" placement="bottom">
              <IconButton
                size="small"
                aria-label="Get directions"
                sx={{ ml: 1, mr: 0.5 }}
                onClick={openDirections}
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
              <AutocompleteDropdown suggestions={displaySuggestions} onSelect={handleSelect} />
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
