import { MaterialIcons } from "@expo/vector-icons";
import { useCategorySearchStore, useDataSourceStore, useMapStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const TEAL = "#007b8b";

export function SearchInAreaChip() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const catMapMoved = useCategorySearchStore((s) => s.mapMoved);
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const setCatSearchBbox = useCategorySearchStore((s) => s.setSearchBbox);
  const setCatMapMoved = useCategorySearchStore((s) => s.setMapMoved);
  const dsMapMoved = useDataSourceStore((s) => s.mapMoved);
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const setDsSearchBbox = useDataSourceStore((s) => s.setSearchBbox);
  const setDsMapMoved = useDataSourceStore((s) => s.setMapMoved);
  const center = useMapStore((s) => s.center);
  const zoom = useMapStore((s) => s.zoom);

  const showForCategory = catMapMoved && activeCategory !== null;
  const showForDataSource = dsMapMoved && activeSource !== null;

  if (!showForCategory && !showForDataSource) return null;

  const handlePress = () => {
    const latDelta = 360 / 2 ** (zoom + 1);
    const lngDelta = 360 / 2 ** zoom;
    const bbox = {
      west: center[0] - lngDelta / 2,
      south: center[1] - latDelta / 2,
      east: center[0] + lngDelta / 2,
      north: center[1] + latDelta / 2,
    };
    if (showForCategory) {
      setCatSearchBbox(bbox);
      setCatMapMoved(false);
    }
    if (showForDataSource) {
      setDsSearchBbox(bbox);
      setDsMapMoved(false);
    }
  };

  return (
    <View style={[styles.container, { top: insets.top + 64 }]} pointerEvents="box-none">
      <Pressable
        onPress={handlePress}
        style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
      >
        <MaterialIcons name="refresh" size={16} color="#fff" />
        <Text style={styles.chipText}>
          {t("category.searchThisArea", { defaultValue: "Search this area" })}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 5,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: TEAL,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 4,
  },
  chipPressed: {
    opacity: 0.85,
  },
  chipText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
});
