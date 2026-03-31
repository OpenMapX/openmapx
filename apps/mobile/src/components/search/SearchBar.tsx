import { MaterialIcons } from "@expo/vector-icons";
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
  resolveStopAsPlace,
  useAdaptiveDebounce,
  useAutocomplete,
  useCategorySearchStore,
  useDataSourceStore,
  useDebounce,
  useDirectionsStore,
  useGeocoding,
  useIntegrationRegistry,
  useLabeledPlaces,
  useMapStore,
  useMenuStore,
  usePlaceStore,
  useSearchStore,
  useStopSearch,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, StyleSheet, TextInput, View } from "react-native";
import { Divider, IconButton, Surface, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HamburgerMenu } from "@/components/menu/HamburgerMenu";
import { useMap } from "@/lib/MapContext";
import { AutocompleteDropdown } from "./AutocompleteDropdown";

const TEAL = "#007b8b";

function useDataSourceCategories(): Record<string, string> {
  const registry = useIntegrationRegistry();
  return useMemo(() => {
    const map: Record<string, string> = {};
    for (const integration of registry.getWithSearchCategory()) {
      const sc = integration.frontend?.searchCategory;
      if (sc?.id) {
        map[sc.id] = integration.id;
      }
    }
    return map;
  }, [registry]);
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

function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

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

function searchRelevance(result: AutocompleteResult, query: string): number {
  const q = query.toLowerCase();
  const label = result.label.toLowerCase();

  let score = diceSimilarity(q, label);

  if (label.startsWith(q)) {
    score += 0.4;
  } else if (label.includes(q)) {
    score += 0.15;
  }

  if (result.sublabel) {
    const sub = result.sublabel.toLowerCase();
    if (sub.includes(q)) score += 0.05;
  }

  if (result.type === "labeled_place") score += 0.5;

  return score;
}

export function SearchBar() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { flyTo } = useMap();
  const queryClient = useQueryClient();
  const inputRef = useRef<TextInput>(null);

  const { query, isFocused, suggestions, setQuery, setIsFocused, setSuggestions, setResults } =
    useSearchStore();
  const { setSelectedPlace } = usePlaceStore();
  const { isOpen: directionsOpen, open: openDirections } = useDirectionsStore();
  const { setActiveCategory, clearCategory } = useCategorySearchStore();
  const dataSourceCategories = useDataSourceCategories();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const setActiveSource = useDataSourceStore((s) => s.setActiveSource);

  const debouncedQuery = useAdaptiveDebounce(query, 150, 50);
  const debouncedGeoQuery = useDebounce(query, 400);
  const { data: autocompleteData, isFetching } = useAutocomplete(debouncedQuery, locale);
  const { data: geocodeData } = useGeocoding(debouncedGeoQuery, locale);

  // Stop search with slower debounce
  const rawStopQuery = query.trim().length >= 2 ? query.trim() : "";
  const debouncedStopQuery = useDebounce(rawStopQuery, 750);
  const { data: stopSearchData } = useStopSearch(debouncedStopQuery);

  // Labeled places (Home, Work, custom)
  const { data: labeledPlaces } = useLabeledPlaces();

  // Short plus code with city
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

  // Coordinate / plus-code synthetic result
  const q = query.trim();
  let syntheticResult: AutocompleteResult | null = null;
  if (q.length >= 2) {
    let parsed = parseCoordinateInput(q) ?? parseDMSCoordinateInput(q);

    if (!parsed) {
      if (shortPlusCity && cityRefData?.[0]) {
        const lngLat = decodeShortPlusCode(shortPlusCity.code, cityRefData[0].coordinates);
        if (lngLat) parsed = { lngLat, label: `${shortPlusCity.code} ${shortPlusCity.city}` };
      }

      if (!parsed) {
        // Use map store center for plus-code decoding (sync access)
        const storeCenter = useMapStore.getState().center;
        const mapCenter: LngLat = storeCenter ?? [0, 20];
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

  // Category suggestions
  const categorySuggestions = useMemo<AutocompleteResult[]>(
    () =>
      q.length >= 1
        ? CATEGORY_DEFINITIONS.filter((cat) =>
            cat.label.toLowerCase().includes(q.toLowerCase()),
          ).map((cat) => ({
            id: `category-${cat.id}`,
            label: cat.label,
            sublabel: t("search.searchCategory"),
            type: "category" as const,
            iconPath: cat.iconPath,
          }))
        : [],
    [q, t],
  );

  // Stop suggestions
  const stopSuggestions = useMemo<AutocompleteResult[]>(
    () =>
      (stopSearchData ?? []).map(
        (stop): AutocompleteResult => ({
          id: `stop-${stop.id}`,
          label: stop.name,
          sublabel: stop.modes
            .map((m) => (MODE_LABEL_KEYS[m] ? t(`searchModes.${MODE_LABEL_KEYS[m]}`) : m))
            .join(", "),
          coordinates: [stop.lng, stop.lat],
          type: "transit_stop",
          transitStop: stop,
        }),
      ),
    [stopSearchData, t],
  );

  // Labeled place suggestions
  const labeledSuggestions = useMemo<AutocompleteResult[]>(
    () =>
      (labeledPlaces ?? [])
        .filter((lp) => {
          if (q.length === 0) return false;
          const ql = q.toLowerCase();
          const translatedLabel =
            lp.label === "home" || lp.label === "work" ? t(`saved.${lp.label}`) : lp.label;
          return (
            translatedLabel.toLowerCase().includes(ql) ||
            lp.name.toLowerCase().includes(ql) ||
            (lp.address?.toLowerCase().includes(ql) ?? false)
          );
        })
        .map((lp): AutocompleteResult => {
          const translatedLabel =
            lp.label === "home" || lp.label === "work" ? t(`saved.${lp.label}`) : lp.label;
          return {
            id: `labeled-${lp.id}`,
            label: translatedLabel,
            sublabel: lp.name + (lp.address ? ` \u2014 ${lp.address}` : ""),
            coordinates: [lp.lng, lp.lat],
            type: "labeled_place",
            labelKey: lp.label,
          };
        }),
    [q, labeledPlaces, t],
  );

  // Merged and deduplicated suggestions
  const displaySuggestions = useMemo(() => {
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
          return dlng * dlng + dlat * dlat < 0.0001;
        }) === i,
    );
  }, [q, syntheticResult, labeledSuggestions, categorySuggestions, suggestions, stopSuggestions]);

  const tryOpenTransitStop = useCallback(
    async (coords: LngLat, name: string): Promise<boolean> => {
      try {
        const delta = 0.005;
        const stops = await apiClient.get<TransitStop[]>(API_ENDPOINTS.transitStops, {
          sw_lat: String(coords[1] - delta),
          sw_lng: String(coords[0] - delta),
          ne_lat: String(coords[1] + delta),
          ne_lng: String(coords[0] + delta),
        });
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
        // Fall back silently
      }
      return false;
    },
    [setSelectedPlace],
  );

  const handleSelect = useCallback(
    (result: AutocompleteResult) => {
      Keyboard.dismiss();

      if (result.type === "labeled_place" && result.coordinates) {
        setQuery(result.label);
        setIsFocused(false);
        flyTo(result.coordinates, 15);
        setSelectedPlace({
          id: result.id,
          name: result.sublabel?.split(" \u2014 ")[0] ?? result.label,
          address: result.sublabel?.split(" \u2014 ")[1] ?? result.sublabel ?? result.label,
          coordinates: result.coordinates,
        });
        router.push(`/place/${encodeURIComponent(result.id)}`);
        return;
      }

      if (result.type === "transit_stop" && result.transitStop) {
        setQuery(result.label);
        setIsFocused(false);
        if (result.coordinates) flyTo(result.coordinates, 15);
        void resolveStopAsPlace(result.transitStop).then((place) => {
          setSelectedPlace(place);
          router.push(`/place/${encodeURIComponent(place.id)}`);
        });
        return;
      }

      if (result.type === "category") {
        const catId = result.id.replace("category-", "");
        // Data source categories that route to the data source panel
        const dsId = dataSourceCategories[catId];
        if (dsId) {
          clearCategory();
          setActiveSource(dsId);
        } else {
          setActiveCategory(catId as Parameters<typeof setActiveCategory>[0]);
        }
        setQuery(result.label);
        setIsFocused(false);
        return;
      }

      // Default: place/address/poi result
      setQuery(result.label);
      setIsFocused(false);
      if (result.coordinates) {
        const coords = result.coordinates;
        flyTo(coords, 15);
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
              router.push(`/place/${encodeURIComponent(result.id)}`);
            } else {
              // Place was already set by tryOpenTransitStop with stop:matchId
              const stopPlace = usePlaceStore.getState().selectedPlace;
              if (stopPlace) {
                router.push(`/place/${encodeURIComponent(stopPlace.id)}`);
              }
            }
          });
        } else {
          setSelectedPlace({
            id: result.id,
            name: result.label,
            address: result.sublabel ?? result.label,
            coordinates: coords,
            category: result.type,
            rawCategory: result.rawCategory,
          });
          router.push(`/place/${encodeURIComponent(result.id)}`);
        }
      }
    },
    [
      setQuery,
      setIsFocused,
      flyTo,
      setSelectedPlace,
      clearCategory,
      setActiveCategory,
      setActiveSource,
      tryOpenTransitStop,
      router,
      dataSourceCategories,
    ],
  );

  const handleSubmit = useCallback(() => {
    Keyboard.dismiss();
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
            router.push(`/place/${encodeURIComponent(first.id)}`);
          } else {
            const stopPlace = usePlaceStore.getState().selectedPlace;
            if (stopPlace) {
              router.push(`/place/${encodeURIComponent(stopPlace.id)}`);
            }
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
        router.push(`/place/${encodeURIComponent(first.id)}`);
      }
    }
  }, [
    syntheticResult,
    geocodeData,
    flyTo,
    handleSelect,
    tryOpenTransitStop,
    setSelectedPlace,
    router,
  ]);

  const handleChangeText = useCallback(
    (text: string) => {
      if (useCategorySearchStore.getState().activeCategory !== null) {
        clearCategory();
      }
      if (activeSource !== null) {
        setActiveSource(null);
      }
      setQuery(text);
    },
    [clearCategory, activeSource, setActiveSource, setQuery],
  );

  const handleClear = useCallback(() => {
    setQuery("");
    inputRef.current?.focus();
  }, [setQuery]);

  const handleFocus = useCallback(() => {
    setIsFocused(true);
  }, [setIsFocused]);

  const handleBack = useCallback(() => {
    Keyboard.dismiss();
    setIsFocused(false);
    if (query.length > 0) {
      setQuery("");
    }
  }, [setIsFocused, query, setQuery]);

  const handleDirections = useCallback(() => {
    openDirections();
    router.push("/directions");
  }, [openDirections, router]);

  if (directionsOpen) return null;

  const showDropdown = isFocused && displaySuggestions.length > 0;
  const showSkeleton =
    isFocused && query.trim().length >= 2 && isFetching && !showDropdown && !syntheticResult;

  return (
    <>
      <View style={[styles.wrapper, { top: insets.top + 8 }]} pointerEvents="box-none">
        <Surface
          style={[styles.surface, showDropdown && styles.surfaceExpanded]}
          elevation={isFocused ? 4 : 2}
        >
          {/* Search input row */}
          <View style={styles.inputRow}>
            {isFocused ? (
              <IconButton
                icon={({ size, color }) => (
                  <MaterialIcons name="arrow-back" size={size} color={color} />
                )}
                size={20}
                onPress={handleBack}
                accessibilityLabel={t("search.menuAriaLabel")}
                style={styles.iconButton}
              />
            ) : (
              <IconButton
                icon={({ size, color }) => <MaterialIcons name="menu" size={size} color={color} />}
                size={20}
                onPress={() => {
                  useMenuStore.getState().open();
                }}
                accessibilityLabel={t("search.menuAriaLabel")}
                style={styles.iconButton}
              />
            )}

            <TextInput
              ref={inputRef}
              testID="search-input"
              value={query}
              onChangeText={handleChangeText}
              onFocus={handleFocus}
              onSubmitEditing={handleSubmit}
              placeholder={t("search.placeholder")}
              placeholderTextColor={theme.colors.onSurfaceVariant}
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
              style={[styles.textInput, { color: theme.colors.onSurface }]}
            />

            {isFocused && query.length > 0 ? (
              <IconButton
                icon={({ size, color }) => <MaterialIcons name="close" size={size} color={color} />}
                size={20}
                onPress={handleClear}
                accessibilityLabel={t("search.closePanelAriaLabel")}
                style={styles.iconButton}
              />
            ) : (
              <IconButton
                testID="directions-button"
                icon={({ size }) => <MaterialIcons name="directions" size={size} color={TEAL} />}
                size={20}
                onPress={handleDirections}
                accessibilityLabel={t("search.getDirectionsAriaLabel")}
                style={styles.iconButton}
              />
            )}
          </View>

          {/* Dropdown */}
          {showDropdown && (
            <>
              <Divider />
              <AutocompleteDropdown suggestions={displaySuggestions} onSelect={handleSelect} />
            </>
          )}

          {/* Skeleton loading */}
          {showSkeleton && (
            <>
              <Divider />
              {[0, 1, 2].map((i) => (
                <View key={i} style={styles.skeletonRow}>
                  <View
                    style={[
                      styles.skeletonCircle,
                      { backgroundColor: theme.colors.surfaceVariant },
                    ]}
                  />
                  <View style={styles.skeletonTextGroup}>
                    <View
                      style={[
                        styles.skeletonLine,
                        styles.skeletonLinePrimary,
                        { backgroundColor: theme.colors.surfaceVariant },
                      ]}
                    />
                    <View
                      style={[
                        styles.skeletonLine,
                        styles.skeletonLineSecondary,
                        { backgroundColor: theme.colors.surfaceVariant },
                      ]}
                    />
                  </View>
                </View>
              ))}
            </>
          )}
        </Surface>
      </View>
      <HamburgerMenu />
    </>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    left: 12,
    right: 12,
    zIndex: 10,
  },
  surface: {
    borderRadius: 24,
    overflow: "hidden",
  },
  surfaceExpanded: {
    borderRadius: 16,
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 48,
    paddingHorizontal: 2,
  },
  iconButton: {
    margin: 0,
    width: 40,
    height: 40,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    paddingVertical: 0,
    paddingHorizontal: 4,
  },
  skeletonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  skeletonCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  skeletonTextGroup: {
    flex: 1,
    gap: 4,
  },
  skeletonLine: {
    height: 12,
    borderRadius: 4,
  },
  skeletonLinePrimary: {
    width: "55%",
  },
  skeletonLineSecondary: {
    width: "35%",
  },
});
