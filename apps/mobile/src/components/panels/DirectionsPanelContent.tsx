import { MaterialIcons } from "@expo/vector-icons";
import type { AutocompleteResult, DirectionsResult, LngLat, TravelMode } from "@openmapx/core";
import {
  formatDistance,
  formatDuration,
  useAutocomplete,
  useDebounce,
  useDirections,
  useDirectionsStore,
  useMapStore,
  useOptimizeRoute,
  useTransitPlan,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, View } from "react-native";
import { Divider, Snackbar, Text, useTheme } from "react-native-paper";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { DetailsView } from "./DetailsView";
import { ModeSelector } from "./ModeSelector";
import { RouteCard } from "./RouteCard";
import { RouteOptions } from "./RouteOptions";
import { TransitPanelContent } from "./transit/TransitPanelContent";
import { WaypointList } from "./WaypointList";

const TEAL = "#007b8b";

export function DirectionsPanelContent() {
  const { t, i18n } = useTranslation();
  const {
    waypoints,
    origin,
    originLabel,
    destination,
    destinationLabel,
    mode,
    activeRouteIndex,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
    transitItineraries,
    setWaypoint,
    addWaypoint,
    removeWaypoint,
    reorderWaypoints,
    reverseWaypoints,
    setOrigin,
    setMode,
    setActiveRouteIndex,
    setTransitItineraries,
  } = useDirectionsStore();

  const theme = useTheme();
  const { userLocation } = useMapStore();
  const queryClient = useQueryClient();
  const optimizeMutation = useOptimizeRoute();

  const [showOptions, setShowOptions] = useState(false);
  const [detailsRouteIndex, setDetailsRouteIndex] = useState<number | null>(null);
  const [focusedField, setFocusedField] = useState<number | null>(null);
  const [snackbar, setSnackbar] = useState<string | null>(null);

  // Per-waypoint input text (synced from store labels)
  const [inputValues, setInputValues] = useState<string[]>(() => waypoints.map((wp) => wp.label));

  // Sync input values when waypoints change externally
  useEffect(() => {
    setInputValues(waypoints.map((wp) => wp.label));
  }, [waypoints]);

  const isTransitMode = mode === "transit";

  // Collect all non-null coords for the route query
  const routeWaypoints = useMemo(
    () =>
      waypoints.reduce<LngLat[]>((acc, wp) => {
        if (wp.coords) acc.push(wp.coords);
        return acc;
      }, []),
    [waypoints],
  );
  const allWaypointsFilled = routeWaypoints.length === waypoints.length && waypoints.length >= 2;

  const { data, isLoading, isError } = useDirections({
    waypoints: isTransitMode ? [] : allWaypointsFilled ? routeWaypoints : [],
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
  });

  // Transit plan query
  const {
    data: transitPlanData,
    isLoading: transitLoading,
    isError: transitError,
  } = useTransitPlan({
    origin: isTransitMode ? origin : null,
    destination: isTransitMode ? destination : null,
    numItineraries: 3,
  });

  useEffect(() => {
    if (transitPlanData?.itineraries) {
      setTransitItineraries(transitPlanData.itineraries);
    }
  }, [transitPlanData, setTransitItineraries]);

  // Autocomplete for the currently focused waypoint input
  const activeQuery = focusedField !== null ? (inputValues[focusedField] ?? "") : "";
  const debouncedActiveQuery = useDebounce(activeQuery, 300);
  const locale = i18n.language;
  const { data: wsSuggestions } = useAutocomplete(debouncedActiveQuery, locale);
  const showSuggestions = focusedField !== null && (wsSuggestions?.length ?? 0) > 0;

  const detailsRoute =
    detailsRouteIndex !== null ? (data?.routes[detailsRouteIndex] ?? null) : null;

  const getCachedTime = useCallback(
    (m: TravelMode): string | undefined => {
      if (!allWaypointsFilled) return undefined;
      if (m === mode && !isTransitMode && data?.routes[0]?.duration !== undefined) {
        return formatDuration(data.routes[0].duration);
      }
      if (m === "transit" && mode === "transit" && transitItineraries[0]?.duration !== undefined) {
        return formatDuration(transitItineraries[0].duration);
      }
      const waypointsStr = routeWaypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");
      const cached = queryClient.getQueryData<DirectionsResult>([
        "directions",
        waypointsStr,
        m,
        avoidHighways,
        avoidTolls,
        avoidFerries,
        units,
      ]);
      const duration = cached?.routes[0]?.duration;
      return duration !== undefined ? formatDuration(duration) : undefined;
    },
    [
      allWaypointsFilled,
      mode,
      data,
      transitItineraries,
      routeWaypoints,
      queryClient,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      units,
      isTransitMode,
    ],
  );

  const loadingMode = isTransitMode ? (transitLoading ? "transit" : null) : isLoading ? mode : null;

  const handleUseMyLocation = useCallback(() => {
    if (userLocation) {
      setOrigin(userLocation, t("directions.myLocation"));
    }
  }, [userLocation, setOrigin, t]);

  const handleWaypointBlur = useCallback(() => {
    setTimeout(() => setFocusedField(null), 200);
  }, []);

  const handleInputChange = useCallback(
    (index: number, value: string) => {
      setInputValues((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
      if (!value) {
        setWaypoint(index, null, "");
      }
    },
    [setWaypoint],
  );

  const handleSuggestionSelect = useCallback(
    (result: AutocompleteResult) => {
      if (!result.coordinates || focusedField === null) return;
      Keyboard.dismiss();
      const { label, coordinates } = result;
      setInputValues((prev) => {
        const next = [...prev];
        next[focusedField] = label;
        return next;
      });
      setWaypoint(focusedField, coordinates, label);
      setFocusedField(null);
    },
    [focusedField, setWaypoint],
  );

  const handleReverse = useCallback(() => {
    reverseWaypoints();
    setInputValues((prev) => [...prev].reverse());
  }, [reverseWaypoints]);

  const handleRemove = useCallback(
    (index: number) => {
      removeWaypoint(index);
      setInputValues((prev) => {
        const next = [...prev];
        next.splice(index, 1);
        return next;
      });
    },
    [removeWaypoint],
  );

  const handleAdd = useCallback(
    (afterIndex: number) => {
      addWaypoint(afterIndex);
      setInputValues((prev) => {
        const next = [...prev];
        next.splice(afterIndex + 1, 0, "");
        return next;
      });
    },
    [addWaypoint],
  );

  const handleOptimize = useCallback(() => {
    if (routeWaypoints.length < 3) return;
    optimizeMutation.mutate(
      {
        waypoints: routeWaypoints,
        mode,
        avoidHighways,
        avoidTolls,
        avoidFerries,
        units,
      },
      {
        onSuccess: (result) => {
          if (result.optimizedOrder) {
            const order = result.optimizedOrder;
            const currentWps = useDirectionsStore.getState().waypoints;
            const reordered = order.map((i) => currentWps[i]);
            for (let i = 0; i < reordered.length; i++) {
              const wp = reordered[i];
              setWaypoint(i, wp.coords, wp.label);
            }
            setSnackbar(t("directions.routeOptimized"));
          }
        },
        onError: () => {
          setSnackbar(t("directions.noRoutesFound"));
        },
      },
    );
  }, [
    routeWaypoints,
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
    optimizeMutation,
    setWaypoint,
    t,
  ]);

  const hasMultipleStops = waypoints.length > 2;
  const showOptimize = hasMultipleStops && allWaypointsFilled && !isTransitMode;

  // Details view
  if (detailsRoute) {
    return (
      <DetailsView
        route={detailsRoute}
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        waypointLabels={waypoints.map((wp) => wp.label)}
        units={units}
        onBack={() => setDetailsRouteIndex(null)}
      />
    );
  }

  return (
    <View testID="directions-panel" style={styles.container}>
      {/* Mode selector */}
      <View style={styles.modeSelectorRow}>
        <ModeSelector
          activeMode={mode}
          onSelectMode={(m) => {
            setMode(m);
            setDetailsRouteIndex(null);
          }}
          getCachedTime={getCachedTime}
          loadingMode={loadingMode}
        />
      </View>

      {/* Waypoint list with drag-and-drop */}
      <WaypointList
        waypoints={waypoints}
        inputValues={inputValues}
        onInputChange={handleInputChange}
        onFocus={setFocusedField}
        onBlur={handleWaypointBlur}
        onReorder={reorderWaypoints}
        onAdd={handleAdd}
        onRemove={handleRemove}
        onReverse={handleReverse}
        onUseMyLocation={userLocation ? handleUseMyLocation : undefined}
        isTransitMode={isTransitMode}
        t={t}
      />

      <Divider />

      {/* Optimize button */}
      {showOptimize && (
        <View style={styles.optimizeContainer}>
          <Pressable onPress={handleOptimize} style={styles.optimizeButton}>
            {optimizeMutation.isPending ? (
              <>
                <ActivityIndicator size={14} color={TEAL} />
                <Text style={styles.optimizeText}>{t("directions.optimizing")}</Text>
              </>
            ) : (
              <>
                <MaterialIcons name="route" size={16} color={TEAL} />
                <Text style={styles.optimizeText}>{t("directions.optimizeStopOrder")}</Text>
              </>
            )}
          </Pressable>
          <Divider />
        </View>
      )}

      {/* Options toggle */}
      {!isTransitMode && (
        <View style={styles.optionsRow}>
          <Pressable onPress={() => setShowOptions((v) => !v)} style={styles.optionsButton}>
            <Text style={styles.optionsText}>{t("directions.options")}</Text>
          </Pressable>
        </View>
      )}

      {showOptions && !isTransitMode && <RouteOptions />}

      <Divider />

      {/* Autocomplete suggestions overlay */}
      {showSuggestions && (
        <View style={[styles.suggestionsOverlay, { backgroundColor: theme.colors.surface }]}>
          <AutocompleteDropdown
            suggestions={wsSuggestions ?? []}
            onSelect={handleSuggestionSelect}
          />
        </View>
      )}

      {/* Route results */}
      {!showSuggestions &&
        (!allWaypointsFilled ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>
              {t("directions.chooseOrigin")}
            </Text>
          </View>
        ) : isTransitMode ? (
          <TransitPanelContent
            itineraries={transitItineraries}
            isLoading={transitLoading}
            isError={transitError}
            provider={transitPlanData?.provider}
          />
        ) : isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size={28} color={TEAL} />
          </View>
        ) : isError ? (
          <View style={styles.emptyState}>
            <Text style={styles.errorText}>{t("directions.noRoutesFound")}</Text>
          </View>
        ) : hasMultipleStops && data?.routes[0] ? (
          // Multi-stop: single route with leg summary
          <Pressable
            onPress={() => setDetailsRouteIndex(0)}
            style={[
              styles.multiStopCard,
              {
                borderLeftColor: TEAL,
                backgroundColor: "rgba(0,123,139,0.04)",
              },
            ]}
          >
            <View style={styles.multiStopHeader}>
              <Text style={[styles.multiStopDuration, { color: theme.colors.onSurface }]}>
                {formatDuration(data.routes[0].duration)}
              </Text>
              <Text style={[styles.multiStopDistance, { color: theme.colors.onSurfaceVariant }]}>
                {units === "imperial"
                  ? `${(data.routes[0].distance / 1609.34).toFixed(1)} mi`
                  : formatDistance(data.routes[0].distance)}
              </Text>
            </View>
            {data.routes[0].legs.length > 1 &&
              data.routes[0].legs.map((leg, i) => {
                const fromLabel = waypoints[i]?.label || t("directions.origin");
                const toLabel = waypoints[i + 1]?.label || t("directions.destination");
                return (
                  <Text
                    key={`leg-${leg.duration}-${leg.distance}`}
                    style={[styles.multiStopLeg, { color: theme.colors.onSurfaceVariant }]}
                  >
                    {fromLabel} → {toLabel} · {formatDuration(leg.duration)} ·{" "}
                    {units === "imperial"
                      ? `${(leg.distance / 1609.34).toFixed(1)} mi`
                      : formatDistance(leg.distance)}
                  </Text>
                );
              })}
            <Pressable onPress={() => setDetailsRouteIndex(0)} style={styles.detailsButton}>
              <Text style={styles.detailsButtonText}>{t("common.details")}</Text>
            </Pressable>
          </Pressable>
        ) : (
          data?.routes.map((route, i) => (
            <View key={`route-${route.duration}-${route.distance}`}>
              <RouteCard
                route={route}
                index={i}
                active={i === activeRouteIndex}
                onSelect={() => setActiveRouteIndex(i)}
                onDetails={() => setDetailsRouteIndex(i)}
                units={units}
              />
              {i < data.routes.length - 1 && <Divider />}
            </View>
          ))
        ))}

      <Snackbar visible={snackbar !== null} onDismiss={() => setSnackbar(null)} duration={3000}>
        {snackbar ?? ""}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  modeSelectorRow: {
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 4,
  },
  optimizeContainer: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  optimizeButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  optimizeText: {
    fontSize: 14,
    fontWeight: "500",
    color: TEAL,
  },
  optionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  optionsButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  optionsText: {
    fontSize: 14,
    fontWeight: "500",
    color: TEAL,
  },
  suggestionsOverlay: {},
  emptyState: {
    paddingHorizontal: 16,
    paddingVertical: 24,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
    color: "#888",
    textAlign: "center",
  },
  errorText: {
    fontSize: 14,
    color: "#d32f2f",
    textAlign: "center",
  },
  loadingContainer: {
    alignItems: "center",
    paddingVertical: 32,
  },
  transitCard: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderLeftWidth: 4,
  },
  transitDuration: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  transitWalk: {
    fontSize: 12,
    color: "#888",
    marginTop: 2,
  },
  multiStopCard: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderLeftWidth: 4,
  },
  multiStopHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  multiStopDuration: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  multiStopDistance: {
    fontSize: 14,
    color: "#888",
  },
  multiStopLeg: {
    fontSize: 12,
    color: "#888",
    marginTop: 4,
    lineHeight: 18,
  },
  detailsButton: {
    alignSelf: "flex-start",
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  detailsButtonText: {
    fontSize: 12,
    fontWeight: "500",
    color: TEAL,
  },
});
