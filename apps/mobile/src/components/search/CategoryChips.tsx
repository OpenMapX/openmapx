import { MaterialIcons } from "@expo/vector-icons";
import type { CategoryId } from "@openmapx/core";
import {
  CATEGORY_DEFINITIONS,
  useCategorySearchStore,
  useDataSourceStore,
  useDataSources,
  useDirectionsStore,
  useSearchStore,
} from "@openmapx/core";
import { useRouter } from "expo-router";
import { useCallback } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Chip } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const TEAL = "#007b8b";

const CATEGORY_ICONS: Partial<Record<CategoryId, string>> = {
  restaurants: "restaurant",
  hotels: "hotel",
  activities: "local-activity",
  museums: "account-balance",
  transit: "directions-bus",
  pharmacies: "local-pharmacy",
  atms: "local-atm",
};

const DATA_SOURCE_ICONS: Record<string, string> = {
  "ev-charging": "ev-station",
  fuel: "local-gas-station",
  parking: "local-parking",
  "bike-sharing": "pedal-bike",
  "scooter-sharing": "electric-scooter",
  "car-sharing": "directions-car",
};

export function CategoryChips() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { activeCategory, setActiveCategory, clearCategory } = useCategorySearchStore();
  const { setQuery } = useSearchStore();
  const { isOpen: directionsOpen } = useDirectionsStore();
  const { activeSource, toggleSource, setActiveSource } = useDataSourceStore();
  const { data: sourcesData } = useDataSources();

  const handleSourcePress = useCallback(
    (sourceId: string, label: string, isActive: boolean) => {
      if (isActive) {
        toggleSource(sourceId);
        setQuery("");
        if (router.canGoBack()) router.back();
      } else {
        clearCategory();
        toggleSource(sourceId);
        setQuery(label);
        router.push(`/datasource/${sourceId}`);
      }
    },
    [toggleSource, setQuery, clearCategory, router],
  );

  const handleCategoryPress = useCallback(
    (catId: CategoryId, label: string, isActive: boolean) => {
      if (isActive) {
        clearCategory();
        setQuery("");
      } else {
        setActiveSource(null);
        setActiveCategory(catId);
        setQuery(label);
        router.push(`/category/${catId}`);
      }
    },
    [clearCategory, setQuery, setActiveSource, setActiveCategory, router],
  );

  const hidden = directionsOpen || activeCategory !== null || activeSource !== null;

  if (hidden) return null;

  // Position chips below the SearchBar (insets.top + 8 padding + 48 bar height + 8 gap)
  const chipsTop = insets.top + 8 + 48 + 8;

  return (
    <View style={[styles.container, { top: chipsTop }]} pointerEvents="box-none">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {(sourcesData?.sources ?? []).map((source) => {
          const isActive = activeSource === source.id;
          const iconName = DATA_SOURCE_ICONS[source.id] ?? "ev-station";
          return (
            <Chip
              key={source.id}
              icon={({ size }) => (
                <MaterialIcons
                  name={iconName as keyof typeof MaterialIcons.glyphMap}
                  size={size}
                  color={isActive ? "#fff" : "#212121"}
                />
              )}
              onPress={() => handleSourcePress(source.id, source.categoryChipLabel, isActive)}
              mode={isActive ? "flat" : "outlined"}
              textStyle={isActive ? styles.chipTextActive : styles.chipTextInactive}
              style={isActive ? styles.chipActive : styles.chipInactive}
              compact
            >
              {source.categoryChipLabel}
            </Chip>
          );
        })}
        {CATEGORY_DEFINITIONS.filter((cat) => cat.showInChipBar).map((cat) => {
          const isActive = activeCategory === cat.id;
          const iconName = CATEGORY_ICONS[cat.id];
          return (
            <Chip
              key={cat.id}
              icon={
                iconName
                  ? ({ size }) => (
                      <MaterialIcons
                        name={iconName as keyof typeof MaterialIcons.glyphMap}
                        size={size}
                        color={isActive ? "#fff" : "#212121"}
                      />
                    )
                  : undefined
              }
              onPress={() => handleCategoryPress(cat.id, cat.label, isActive)}
              mode={isActive ? "flat" : "outlined"}
              textStyle={isActive ? styles.chipTextActive : styles.chipTextInactive}
              style={isActive ? styles.chipActive : styles.chipInactive}
              compact
            >
              {cat.label}
            </Chip>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 8,
  },
  scrollContent: {
    paddingHorizontal: 12,
    gap: 8,
    paddingVertical: 2,
  },
  chipActive: {
    backgroundColor: TEAL,
    borderColor: TEAL,
    borderRadius: 18,
  },
  chipInactive: {
    backgroundColor: "#fff",
    borderColor: "rgba(0,0,0,0.23)",
    borderRadius: 18,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 2,
  },
  chipTextActive: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "500",
  },
  chipTextInactive: {
    color: "#212121",
    fontSize: 13,
    fontWeight: "500",
  },
});
