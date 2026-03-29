import { MaterialIcons } from "@expo/vector-icons";
import type { OpeningHoursFilter } from "@openmapx/core";
import {
  HOURS_FILTER_CATEGORY_IDS,
  useCategorySearchStore,
  useDataSourceStore,
  useOpeningHoursStore,
} from "@openmapx/core";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Button, Divider, RadioButton, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const TEAL = "#007b8b";

const DAYS: { key: string; idx: number }[] = [
  { key: "monday", idx: 1 },
  { key: "tuesday", idx: 2 },
  { key: "wednesday", idx: 3 },
  { key: "thursday", idx: 4 },
  { key: "friday", idx: 5 },
  { key: "saturday", idx: 6 },
  { key: "sunday", idx: 0 },
];

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function chipLabel(
  filter: OpeningHoursFilter,
  openAtDay: number | null,
  openAtHour: number | null,
  t: (key: string, opts?: Record<string, string>) => string,
): string {
  if (filter === "open_now") return t("category.openNow", { defaultValue: "Open now" });
  if (filter === "open_24h") return t("category.open24h", { defaultValue: "Open 24h" });
  if (filter === "open_at") {
    const d = openAtDay !== null ? DAY_SHORT[openAtDay] : null;
    const h = openAtHour !== null ? `${String(openAtHour).padStart(2, "0")}:00` : null;
    if (d && h) return `${d} \u00b7 ${h}`;
    if (d) return d;
    if (h) return h;
  }
  return t("category.openingTimes", { defaultValue: "Opening times" });
}

const HOUR_OPTIONS: { value: number | null }[] = [
  { value: null },
  ...Array.from({ length: 24 }, (_, h) => ({ value: h })),
];

function PickerPill({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[pickerStyles.pill, selected && pickerStyles.pillSelected]}>
      <Text style={[pickerStyles.pillText, selected && pickerStyles.pillTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

const pickerStyles = StyleSheet.create({
  pill: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignItems: "center",
  },
  pillSelected: {
    borderColor: TEAL,
    backgroundColor: "rgba(0, 123, 139, 0.08)",
  },
  pillText: {
    fontSize: 13,
    color: "#333",
    textAlign: "center",
  },
  pillTextSelected: {
    color: TEAL,
    fontWeight: "600",
  },
});

export function CategoryFilterBar() {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const { openingHoursFilter, openAtDay, openAtHour, setOpeningHoursFilter, setOpenAtFilter } =
    useOpeningHoursStore();
  const activeSource = useDataSourceStore((s) => s.activeSource);

  const [modalVisible, setModalVisible] = useState(false);
  const [pendingMode, setPendingMode] = useState<OpeningHoursFilter>(openingHoursFilter);
  const [pendingDay, setPendingDay] = useState<number | null>(openAtDay);
  const [pendingHour, setPendingHour] = useState<number | null>(openAtHour);

  const openModal = useCallback(() => {
    setPendingMode(openingHoursFilter);
    setPendingDay(openAtDay);
    setPendingHour(openAtHour);
    setModalVisible(true);
  }, [openingHoursFilter, openAtDay, openAtHour]);

  // Position below the SearchBar (insets.top + 8 padding + 48 bar height + 8 gap)
  const filterBarTop = insets.top + 8 + 48 + 8;

  // Fuel stations: simple "Open now" toggle chip
  if (activeSource === "fuel") {
    const isFiltered = openingHoursFilter === "open_now";
    return (
      <View style={[styles.container, { top: filterBarTop }]} pointerEvents="box-none">
        <Pressable
          onPress={() => setOpeningHoursFilter(isFiltered ? "any" : "open_now")}
          style={[styles.chip, isFiltered ? styles.chipActive : styles.chipInactive]}
        >
          <MaterialIcons name="access-time" size={16} color={isFiltered ? "#fff" : "#333"} />
          <Text
            style={[styles.chipText, isFiltered ? styles.chipTextActive : styles.chipTextInactive]}
          >
            {t("category.openNow", { defaultValue: "Open now" })}
          </Text>
        </Pressable>
      </View>
    );
  }

  if (!activeCategory || !HOURS_FILTER_CATEGORY_IDS.has(activeCategory)) return null;

  const isFiltered = openingHoursFilter !== "any";
  const label = chipLabel(openingHoursFilter, openAtDay, openAtHour, t);

  const handleApply = () => {
    if (pendingMode === "open_at") {
      setOpenAtFilter(pendingDay, pendingHour);
    } else {
      setOpeningHoursFilter(pendingMode);
    }
    setModalVisible(false);
  };

  const handleClear = () => {
    setPendingMode("any");
    setPendingDay(null);
    setPendingHour(null);
    setOpeningHoursFilter("any");
    setModalVisible(false);
  };

  return (
    <View style={[styles.container, { top: filterBarTop }]} pointerEvents="box-none">
      <Pressable
        onPress={openModal}
        style={[styles.chip, isFiltered ? styles.chipActive : styles.chipInactive]}
      >
        <MaterialIcons name="access-time" size={16} color={isFiltered ? "#fff" : "#333"} />
        <Text
          style={[styles.chipText, isFiltered ? styles.chipTextActive : styles.chipTextInactive]}
        >
          {label}
        </Text>
        <MaterialIcons name="expand-more" size={16} color={isFiltered ? "#fff" : "#333"} />
      </Pressable>

      <Modal
        visible={modalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable style={styles.modalBackdrop} onPress={() => setModalVisible(false)} />
          <View
            style={[
              styles.modalContent,
              { paddingBottom: Math.max(insets.bottom, 20), backgroundColor: theme.colors.surface },
            ]}
          >
            <View style={styles.modalHandle} />

            {/* Radio options */}
            <View style={styles.radioGroup}>
              {(
                [
                  { value: "any", label: t("category.anyTime", { defaultValue: "Any time" }) },
                  { value: "open_now", label: t("category.openNow", { defaultValue: "Open now" }) },
                  { value: "open_24h", label: t("category.open24h", { defaultValue: "Open 24h" }) },
                ] as { value: OpeningHoursFilter; label: string }[]
              ).map((opt) => (
                <Pressable
                  key={opt.value}
                  onPress={() => setPendingMode(opt.value)}
                  style={styles.radioRow}
                >
                  <RadioButton
                    value={opt.value}
                    status={pendingMode === opt.value ? "checked" : "unchecked"}
                    onPress={() => setPendingMode(opt.value)}
                    color={TEAL}
                  />
                  <Text style={styles.radioLabel}>{opt.label}</Text>
                </Pressable>
              ))}
            </View>

            <Divider />

            {/* Open at option */}
            <Pressable onPress={() => setPendingMode("open_at")} style={styles.radioRow}>
              <RadioButton
                value="open_at"
                status={pendingMode === "open_at" ? "checked" : "unchecked"}
                onPress={() => setPendingMode("open_at")}
                color={TEAL}
              />
              <Text style={styles.radioLabel}>
                {t("category.openAt", { defaultValue: "Open at" })}
              </Text>
            </Pressable>

            {/* Day + Time pickers */}
            <View
              style={[styles.pickersRow, pendingMode !== "open_at" && styles.pickersDimmed]}
              pointerEvents={pendingMode === "open_at" ? "auto" : "none"}
            >
              {/* Days */}
              <View style={styles.daysColumn}>
                {DAYS.map((d) => (
                  <PickerPill
                    key={d.idx}
                    label={t(`category.${d.key}`, { defaultValue: d.key })}
                    selected={pendingDay === d.idx}
                    onPress={() => setPendingDay(pendingDay === d.idx ? null : d.idx)}
                  />
                ))}
              </View>

              <View style={styles.pickerDivider} />

              {/* Hours */}
              <ScrollView style={styles.hoursColumn} showsVerticalScrollIndicator={false}>
                {HOUR_OPTIONS.map((h) => (
                  <PickerPill
                    key={h.value ?? "any"}
                    label={
                      h.value === null
                        ? t("category.anyTime", { defaultValue: "Any time" })
                        : `${String(h.value).padStart(2, "0")}:00`
                    }
                    selected={pendingHour === h.value}
                    onPress={() => setPendingHour(pendingHour === h.value ? null : h.value)}
                  />
                ))}
              </ScrollView>
            </View>

            <Divider />

            {/* Footer */}
            <View style={styles.footer}>
              <Button mode="text" onPress={handleClear} textColor="#666" compact>
                {t("common.clear", { defaultValue: "Clear" })}
              </Button>
              <Button
                mode="text"
                onPress={handleApply}
                textColor={TEAL}
                compact
                labelStyle={{ fontWeight: "600" }}
              >
                {t("common.apply", { defaultValue: "Apply" })}
              </Button>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 8,
    flexDirection: "row",
    paddingHorizontal: 8,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 14,
    borderWidth: 1,
  },
  chipActive: {
    backgroundColor: TEAL,
    borderColor: TEAL,
  },
  chipInactive: {
    backgroundColor: "#fff",
    borderColor: "#ddd",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  chipText: {
    fontSize: 13,
    fontWeight: "500",
  },
  chipTextActive: {
    color: "#fff",
  },
  chipTextInactive: {
    color: "#333",
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  modalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#ccc",
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 8,
  },
  radioGroup: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  radioRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    paddingHorizontal: 16,
  },
  radioLabel: {
    fontSize: 15,
    marginLeft: 4,
  },
  pickersRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
    marginBottom: 8,
    paddingHorizontal: 16,
    maxHeight: 280,
  },
  pickersDimmed: {
    opacity: 0.35,
  },
  daysColumn: {
    width: 130,
    gap: 6,
  },
  pickerDivider: {
    width: 1,
    backgroundColor: "#e0e0e0",
  },
  hoursColumn: {
    flex: 1,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
});
