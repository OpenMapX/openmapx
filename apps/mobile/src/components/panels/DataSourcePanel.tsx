import { MaterialIcons } from "@expo/vector-icons";
import type { DataSourceResult } from "@openmapx/core";
import {
  useDataSourceSearch,
  useDataSourceStore,
  useDataSources,
  useOpeningHoursStore,
  usePlaceStore,
} from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { ActivityIndicator, Chip, Divider, Text } from "react-native-paper";
import { useMap } from "@/lib/MapContext";
import { DataSourceFilterContent } from "./DataSourceFilterContent";

const _TEAL = "#007b8b";

/** Filter IDs that are applied client-side instead of being sent to the API. */
const CLIENT_SIDE_FILTER_IDS = new Set(["operator", "speed"]);

function ResultCard({
  result,
  onSelect,
}: {
  result: DataSourceResult;
  onSelect: (r: DataSourceResult) => void;
}) {
  return (
    <Pressable
      onPress={() => onSelect(result)}
      style={({ pressed }) => [cardStyles.card, pressed && cardStyles.cardPressed]}
    >
      <Text variant="bodyLarge" style={cardStyles.name}>
        {result.name}
      </Text>
      <View style={cardStyles.metaRow}>
        {result.operator && (
          <Text variant="labelSmall" style={cardStyles.meta}>
            {result.operator}
          </Text>
        )}
        {result.summary && (
          <Text variant="labelSmall" style={cardStyles.meta}>
            {result.summary}
          </Text>
        )}
      </View>
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
    gap: 6,
  },
  meta: {
    color: "#666",
  },
});

export function DataSourcePanel() {
  const { t } = useTranslation();
  const router = useRouter();
  const { flyTo } = useMap();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const filters = useDataSourceStore((s) => s.filters);
  const searchBbox = useDataSourceStore((s) => s.searchBbox);
  const viewportZoom = useDataSourceStore((s) => s.viewportZoom);
  const selectItem = useDataSourceStore((s) => s.selectItem);
  const clearFilters = useDataSourceStore((s) => s.clearFilters);
  const openingHoursFilter = useOpeningHoursStore((s) => s.openingHoursFilter);
  const { setSelectedPlace } = usePlaceStore();
  const { data: sourcesData } = useDataSources();

  // Find metadata for the active source
  const sourceMeta = useMemo(() => {
    if (!activeSource || !sourcesData?.sources) return null;
    return sourcesData.sources.find((s) => s.id === activeSource) ?? null;
  }, [activeSource, sourcesData]);

  // Separate client-side vs server-side filters
  const serverFilters = useMemo(() => {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filters)) {
      if (!CLIENT_SIDE_FILTER_IDS.has(key)) {
        result[key] = value;
      }
    }
    return result;
  }, [filters]);

  // Only fetch if zoom >= minZoom
  const shouldFetch =
    activeSource !== null &&
    searchBbox !== null &&
    (sourceMeta ? viewportZoom >= sourceMeta.minZoom : true);

  const {
    data: rawResults,
    isLoading,
    isFetching,
  } = useDataSourceSearch(
    shouldFetch ? activeSource : null,
    shouldFetch ? searchBbox : null,
    serverFilters,
  );

  const showLoading = isLoading || (isFetching && (!rawResults || rawResults.length === 0));

  // Apply client-side filters
  const filteredResults = useMemo(() => {
    if (!rawResults) return [];
    let results = [...rawResults];

    const speedFilter = filters.speed;
    if (speedFilter) {
      const speedValues = Array.isArray(speedFilter)
        ? (speedFilter as string[])
        : [String(speedFilter)];
      if (speedValues.length > 0) {
        const speedSet = new Set(speedValues);
        results = results.filter((r) => speedSet.has(r.variant));
      }
    }

    const operatorFilter = filters.operator;
    if (operatorFilter) {
      const operatorValues = Array.isArray(operatorFilter)
        ? (operatorFilter as string[])
        : [String(operatorFilter)];
      if (operatorValues.length > 0) {
        const operatorSet = new Set(operatorValues);
        results = results.filter((r) => r.operator && operatorSet.has(r.operator));
      }
    }

    if (openingHoursFilter === "open_now") {
      results = results.filter((r) => r.variant === "open");
    }

    return results;
  }, [rawResults, filters.speed, filters.operator, openingHoursFilter]);

  // Check if any filters are active
  const hasActiveFilters = Object.values(filters).some((v) => {
    if (Array.isArray(v)) return v.length > 0;
    return v !== undefined && v !== null;
  });

  const handleSelectResult = useCallback(
    (result: DataSourceResult) => {
      if (!activeSource) return;
      flyTo(result.coordinates, 17);
      selectItem(activeSource, result.id);
      setSelectedPlace({
        id: result.id,
        name: result.name,
        address: result.name,
        coordinates: result.coordinates,
        category: sourceMeta?.placeCategory,
        rawCategory: sourceMeta?.placeCategoryRaw,
      });
      router.push(`/place/${encodeURIComponent(result.id)}`);
    },
    [activeSource, flyTo, selectItem, setSelectedPlace, sourceMeta, router],
  );

  if (!sourceMeta) return null;

  const belowMinZoom = viewportZoom < sourceMeta.minZoom;

  return (
    <View style={styles.container}>
      {/* Filter section */}
      <DataSourceFilterContent />

      {/* Clear all filters */}
      {hasActiveFilters && (
        <View style={styles.clearRow}>
          <Chip
            icon="close-circle"
            onPress={clearFilters}
            compact
            style={styles.clearChip}
            textStyle={styles.clearChipText}
          >
            {t("dataSources.clearAllFilters", { defaultValue: "Clear all filters" })}
          </Chip>
        </View>
      )}

      <Divider />

      {/* Below min zoom message */}
      {belowMinZoom && (
        <View style={styles.messageContainer}>
          <MaterialIcons name="zoom-in" size={24} color="#666" />
          <Text style={styles.messageText}>
            {t("dataSources.zoomIn", { defaultValue: "Zoom in to see results" })}
          </Text>
        </View>
      )}

      {/* Loading */}
      {!belowMinZoom && showLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" />
        </View>
      )}

      {/* Results count + list */}
      {!belowMinZoom &&
        !showLoading &&
        filteredResults.length > 0 &&
        sourceMeta.showResultsList !== false && (
          <>
            <View style={styles.countRow}>
              <Text variant="bodySmall" style={styles.countText}>
                {t("common.resultsCount", {
                  count: filteredResults.length,
                  defaultValue: `${filteredResults.length} results`,
                })}
              </Text>
            </View>
            {filteredResults.map((result, i) => (
              <View key={result.id}>
                {i > 0 && <Divider style={styles.divider} />}
                <ResultCard result={result} onSelect={handleSelectResult} />
              </View>
            ))}
          </>
        )}

      {/* Empty state */}
      {!belowMinZoom &&
        !showLoading &&
        filteredResults.length === 0 &&
        rawResults !== undefined && (
          <View style={styles.messageContainer}>
            <Text style={styles.messageText}>
              {t("search.noResultsFound", { defaultValue: "No results found" })}
            </Text>
          </View>
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 8,
  },
  clearRow: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  clearChip: {
    alignSelf: "flex-start",
  },
  clearChipText: {
    fontSize: 12,
  },
  loadingContainer: {
    padding: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  messageContainer: {
    paddingHorizontal: 16,
    paddingVertical: 32,
    alignItems: "center",
    gap: 8,
  },
  messageText: {
    color: "#666",
    textAlign: "center",
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
