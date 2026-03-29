import { MaterialIcons } from "@expo/vector-icons";
import type { CategoryPlace, TransitStop, TransportMode } from "@openmapx/core";
import {
  categoryPlaceToPlace,
  parseOpeningHours,
  resolveProvider,
  resolveStopAsPlace,
  useCategorySearchStore,
  useFilteredCategoryResults,
  useMapStore,
  usePlaceStore,
  useProviders,
  useTransitStops,
} from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { ActivityIndicator, Divider, Text } from "react-native-paper";
import { useMap } from "@/lib/MapContext";

const TRANSIT_MODE_ICONS: Partial<Record<TransportMode, string>> = {
  rail: "train",
  tram: "tram",
  bus: "directions-bus",
};

function TransitStopCard({
  stop,
  onSelect,
  providers,
}: {
  stop: TransitStop;
  onSelect: (stop: TransitStop) => void;
  providers: Record<string, { label: string; url: string }> | undefined;
}) {
  const resolved = resolveProvider(providers ?? {}, stop.provider);
  return (
    <Pressable
      onPress={() => onSelect(stop)}
      style={({ pressed }) => [cardStyles.card, pressed && cardStyles.cardPressed]}
    >
      <Text variant="bodyLarge" style={cardStyles.name}>
        {stop.name}
      </Text>
      <View style={cardStyles.metaRow}>
        {Array.from(new Set(stop.modes)).map((m) => {
          const iconName = TRANSIT_MODE_ICONS[m] ?? "directions-bus";
          return (
            <MaterialIcons
              key={m}
              name={iconName as keyof typeof MaterialIcons.glyphMap}
              size={16}
              color="#666"
            />
          );
        })}
        <Text variant="labelSmall" style={cardStyles.provider}>
          {resolved.label}
          {resolved.license ? ` (${resolved.license})` : ""}
        </Text>
      </View>
    </Pressable>
  );
}

function CategoryPlaceCard({
  place,
  onSelect,
}: {
  place: CategoryPlace;
  onSelect: (place: CategoryPlace) => void;
}) {
  const { t } = useTranslation();
  const tagLabel = place.category
    ? place.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;

  const hours = parseOpeningHours(place.openingHours, {
    lat: place.coordinates[1],
    lon: place.coordinates[0],
  });

  return (
    <Pressable
      onPress={() => onSelect(place)}
      style={({ pressed }) => [cardStyles.card, pressed && cardStyles.cardPressed]}
    >
      <Text variant="bodyLarge" style={cardStyles.name}>
        {place.name}
      </Text>
      <View style={cardStyles.metaRow}>
        {tagLabel && (
          <Text variant="labelSmall" style={cardStyles.meta}>
            {tagLabel}
          </Text>
        )}
        {tagLabel && place.address && (
          <Text variant="labelSmall" style={cardStyles.meta}>
            {"\u00b7"}
          </Text>
        )}
        {place.address && (
          <Text variant="labelSmall" style={cardStyles.meta}>
            {place.address}
          </Text>
        )}
      </View>
      {hours ? (
        <Text
          variant="labelSmall"
          style={[cardStyles.status, { color: hours.isOpen ? "#2e7d32" : "#c62828" }]}
        >
          {hours.isOpen
            ? t("place.openDetail", {
                detail: hours.detail,
                defaultValue: `Open \u00b7 ${hours.detail}`,
              })
            : t("place.closedDetail", {
                detail: hours.detail,
                defaultValue: `Closed \u00b7 ${hours.detail}`,
              })}
        </Text>
      ) : place.isOpen !== undefined ? (
        <Text
          variant="labelSmall"
          style={[cardStyles.status, { color: place.isOpen ? "#2e7d32" : "#c62828" }]}
        >
          {place.isOpen
            ? t("common.open", { defaultValue: "Open" })
            : t("common.closed", { defaultValue: "Closed" })}
        </Text>
      ) : null}
    </Pressable>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  cardPressed: {
    backgroundColor: "rgba(0,0,0,0.06)",
  },
  name: {
    fontWeight: "600",
    marginBottom: 2,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    marginBottom: 2,
  },
  meta: {
    color: "#666",
  },
  provider: {
    color: "#666",
  },
  status: {
    marginTop: 2,
  },
});

export function CategoryResultsContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const { activeCategory, searchBbox, setSearchBbox, setMapMoved } = useCategorySearchStore();
  const { setSelectedPlace } = usePlaceStore();
  const { flyTo } = useMap();
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);

  const { filtered, isLoading, isError, isTransitCategory } = useFilteredCategoryResults();
  const { data: transitStops, isPending: transitPending } = useTransitStops(
    isTransitCategory ? searchBbox : null,
  );
  const { data: providers } = useProviders();
  const transitLoading = isTransitCategory && transitPending;

  const prevCategoryRef = useRef<string | null>(null);

  const results = filtered;

  // Auto-search when category becomes active or changes
  useEffect(() => {
    if (!activeCategory) return;
    if (activeCategory === prevCategoryRef.current) return;
    prevCategoryRef.current = activeCategory;

    const latDelta = 360 / 2 ** (zoom + 1);
    const lngDelta = 360 / 2 ** zoom;
    setSearchBbox({
      west: center[0] - lngDelta / 2,
      south: center[1] - latDelta / 2,
      east: center[0] + lngDelta / 2,
      north: center[1] + latDelta / 2,
    });
    setMapMoved(false);
  }, [activeCategory, center, zoom, setSearchBbox, setMapMoved]);

  // Clear prev category ref when category is cleared
  useEffect(() => {
    if (!activeCategory) {
      prevCategoryRef.current = null;
      setMapMoved(false);
    }
  }, [activeCategory, setMapMoved]);

  const handleSelectPlace = useCallback(
    (place: CategoryPlace) => {
      flyTo(place.coordinates, 17);
      setSelectedPlace(categoryPlaceToPlace(place, activeCategory ?? undefined));
      router.push(`/place/${encodeURIComponent(place.id)}`);
    },
    [flyTo, setSelectedPlace, activeCategory, router],
  );

  const handleSelectStop = useCallback(
    (s: TransitStop) => {
      flyTo([s.lng, s.lat], 16);
      void resolveStopAsPlace(s).then((place) => {
        setSelectedPlace(place);
        router.push(`/place/${encodeURIComponent(place.id)}`);
      });
    },
    [flyTo, setSelectedPlace, router],
  );

  return (
    <View style={styles.container}>
      {(isTransitCategory ? transitLoading : isLoading) && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" />
        </View>
      )}

      {!isTransitCategory && isError && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            {t("search.failedToLoad", { defaultValue: "Failed to load results" })}
          </Text>
        </View>
      )}

      {/* Transit: empty state */}
      {isTransitCategory && !transitLoading && transitStops && transitStops.length === 0 && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            {t("search.noStopsFound", { defaultValue: "No stops found in this area" })}
          </Text>
        </View>
      )}

      {/* Transit: results list */}
      {isTransitCategory && !transitLoading && transitStops && transitStops.length > 0 && (
        <>
          <View style={styles.countRow}>
            <Text variant="bodySmall" style={styles.countText}>
              {t("common.stopsCount", {
                count: transitStops.length,
                defaultValue: `${transitStops.length} stops`,
              })}
            </Text>
          </View>
          {transitStops.map((stop, i) => (
            <View key={stop.id}>
              {i > 0 && <Divider style={styles.divider} />}
              <TransitStopCard stop={stop} onSelect={handleSelectStop} providers={providers} />
            </View>
          ))}
        </>
      )}

      {/* Non-transit: empty state */}
      {!isTransitCategory && !isLoading && !isError && results && results.length === 0 && (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            {t("search.noResultsFound", { defaultValue: "No results found" })}
          </Text>
        </View>
      )}

      {/* Non-transit: results list */}
      {!isTransitCategory && !isLoading && results && results.length > 0 && (
        <>
          <View style={styles.countRow}>
            <Text variant="bodySmall" style={styles.countText}>
              {t("common.resultsCount", {
                count: results.length,
                defaultValue: `${results.length} results`,
              })}
            </Text>
          </View>
          {results.map((place, i) => (
            <View key={place.id}>
              {i > 0 && <Divider style={styles.divider} />}
              <CategoryPlaceCard place={place} onSelect={handleSelectPlace} />
            </View>
          ))}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 8,
  },
  loadingContainer: {
    padding: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyContainer: {
    paddingHorizontal: 16,
    paddingVertical: 32,
    alignItems: "center",
  },
  emptyText: {
    color: "#666",
  },
  countRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  countText: {
    color: "#666",
  },
  divider: {
    marginHorizontal: 16,
  },
});
