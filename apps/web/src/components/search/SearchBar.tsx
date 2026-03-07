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
import type { AutocompleteResult, LngLat } from "@openmapx/core";
import {
  decodeShortPlusCode,
  detectShortPlusCodeCity,
  parseCoordinateInput,
  parseDMSCoordinateInput,
  parsePlusCodeInput,
  useActiveSidePanel,
  useAutocomplete,
  useDirectionsStore,
  useGeocoding,
  usePlaceStore,
  useSearchStore,
} from "@openmapx/core";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";
import { AutocompleteDropdown } from "./AutocompleteDropdown";

export function SearchBar() {
  const { query, isFocused, suggestions, setQuery, setIsFocused, setSuggestions, setResults } =
    useSearchStore();
  const { setSelectedPlace } = usePlaceStore();
  const { isOpen: hasSidePanel, close: closeSidePanel } = useActiveSidePanel();
  const { isOpen: directionsOpen, open: openDirections } = useDirectionsStore();
  const { flyTo, mapRef } = useMap();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: autocompleteData, isFetching } = useAutocomplete(query);
  const { data: geocodeData } = useGeocoding(query);
  // When user types a short plus code with city, geocode the city name to get
  // the reference coordinates for decoding. Debounced to avoid firing on every keystroke.
  const shortPlusCity = detectShortPlusCodeCity(query.trim());
  const [debouncedCity, setDebouncedCity] = useState("");
  useEffect(() => {
    const city = shortPlusCity?.city ?? "";
    const timer = setTimeout(() => setDebouncedCity(city), 400);
    return () => clearTimeout(timer);
  }, [shortPlusCity?.city]);
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
        id: "special-input",
        label: parsed.label,
        coordinates: parsed.lngLat,
        type: "address",
      };
    }
  }

  const displaySuggestions = syntheticResult ? [syntheticResult] : suggestions;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
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
      setSelectedPlace({
        id: first.id,
        name: first.label,
        address: first.label,
        coordinates: first.coordinates,
        category: first.type,
      });
    }
  };

  const handleSelect = (result: AutocompleteResult) => {
    setQuery(result.label);
    setIsFocused(false);
    if (result.coordinates) {
      flyTo(result.coordinates, 15);
      setSelectedPlace({
        id: result.id,
        name: result.label,
        address: result.sublabel ?? result.label,
        coordinates: result.coordinates,
        category: result.type,
      });
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
            onBlur={() => setTimeout(() => setIsFocused(false), 150)}
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

          <Divider orientation="vertical" flexItem sx={{ mx: 0.5, my: 1 }} />
          {hasSidePanel ? (
            <IconButton
              size="small"
              aria-label="Close panel"
              sx={{ mr: 0.5 }}
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
                sx={{ mr: 0.5 }}
                onClick={openDirections}
              >
                <DirectionsIcon sx={{ fontSize: 22, color: "primary.main" }} />
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
