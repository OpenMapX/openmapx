import type { OpeningHoursFilter } from "@openmapx/core";
import {
  HOURS_FILTER_CATEGORY_IDS,
  useCategorySearchStore,
  useOpeningHoursStore,
} from "@openmapx/core";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Chip, Text } from "react-native-paper";

const TEAL = "#007b8b";

const FILTER_OPTIONS: { value: OpeningHoursFilter; labelKey: string; defaultValue: string }[] = [
  { value: "any", labelKey: "category.anyTime", defaultValue: "Any time" },
  { value: "open_now", labelKey: "category.openNow", defaultValue: "Open now" },
  { value: "open_24h", labelKey: "category.open24h", defaultValue: "Open 24h" },
];

/**
 * Extended filter content for categories, shown inside the bottom sheet.
 * Provides quick-access chips for opening hours filters (any/open now/open 24h).
 */
export function CategoryFilterContent() {
  const { t } = useTranslation();
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const { openingHoursFilter, setOpeningHoursFilter } = useOpeningHoursStore();

  const handleSelect = useCallback(
    (value: OpeningHoursFilter) => {
      setOpeningHoursFilter(value);
    },
    [setOpeningHoursFilter],
  );

  if (!activeCategory || !HOURS_FILTER_CATEGORY_IDS.has(activeCategory)) return null;

  return (
    <View style={styles.container}>
      <Text variant="labelMedium" style={styles.label}>
        {t("category.openingTimes", { defaultValue: "Opening times" })}
      </Text>
      <View style={styles.chipRow}>
        {FILTER_OPTIONS.map((opt) => {
          const isActive = openingHoursFilter === opt.value;
          return (
            <Chip
              key={opt.value}
              selected={isActive}
              onPress={() => handleSelect(opt.value)}
              mode={isActive ? "flat" : "outlined"}
              selectedColor={isActive ? "#fff" : undefined}
              style={[styles.chip, isActive && styles.chipActive]}
              textStyle={[styles.chipText, isActive && styles.chipTextActive]}
            >
              {t(opt.labelKey, { defaultValue: opt.defaultValue })}
            </Chip>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  label: {
    color: "#666",
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    borderRadius: 18,
  },
  chipActive: {
    backgroundColor: TEAL,
  },
  chipText: {
    fontSize: 13,
  },
  chipTextActive: {
    color: "#fff",
  },
});
