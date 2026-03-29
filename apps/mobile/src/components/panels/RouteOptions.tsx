import { MaterialIcons } from "@expo/vector-icons";
import { useDirectionsStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Divider, Text } from "react-native-paper";

const TEAL = "#007b8b";

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Pressable onPress={() => onChange(!checked)} style={styles.checkRow}>
      <MaterialIcons
        name={checked ? "check-box" : "check-box-outline-blank"}
        size={20}
        color={checked ? TEAL : "#888"}
      />
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

function RadioRow({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable onPress={onSelect} style={styles.checkRow}>
      <MaterialIcons
        name={selected ? "radio-button-checked" : "radio-button-unchecked"}
        size={20}
        color={selected ? TEAL : "#888"}
      />
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  );
}

export function RouteOptions() {
  const { t } = useTranslation();
  const {
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
    setAvoidHighways,
    setAvoidTolls,
    setAvoidFerries,
    setUnits,
  } = useDirectionsStore();

  return (
    <View style={styles.container}>
      <Divider />
      <View style={styles.columns}>
        <View style={styles.column}>
          <Text style={styles.sectionHeader}>{t("directions.avoid").toUpperCase()}</Text>
          <CheckRow
            label={t("directions.highways")}
            checked={avoidHighways}
            onChange={setAvoidHighways}
          />
          <CheckRow label={t("directions.tolls")} checked={avoidTolls} onChange={setAvoidTolls} />
          <CheckRow
            label={t("directions.ferries")}
            checked={avoidFerries}
            onChange={setAvoidFerries}
          />
        </View>
        <View style={styles.column}>
          <Text style={styles.sectionHeader}>{t("directions.distance").toUpperCase()}</Text>
          <RadioRow
            label={t("directions.kilometres")}
            selected={units === "metric"}
            onSelect={() => setUnits("metric")}
          />
          <RadioRow
            label={t("directions.miles")}
            selected={units === "imperial"}
            onSelect={() => setUnits("imperial")}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  columns: {
    flexDirection: "row",
    gap: 32,
    marginTop: 12,
  },
  column: {
    flex: 1,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: "600",
    color: "#888",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  checkLabel: {
    fontSize: 14,
    color: "#333",
  },
});
