import { useCyclingStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Surface, Text } from "react-native-paper";

const CYCLING_COLORS = {
  track: "#0D7C3D",
  lane: "#2E8B57",
  designated: "#4A90D9",
  permitted: "#7CB342",
  parking: "#1565C0",
  shop: "#6A1B9A",
  repair: "#E65100",
  rental: "#00838F",
} as const;

const LINE_ITEMS = [
  { colorKey: "track" as const, labelKey: "dedicatedCycleway", fallback: "Cycleway" },
  { colorKey: "lane" as const, labelKey: "bikeLane", fallback: "Bike lane" },
  { colorKey: "designated" as const, labelKey: "bicycleDesignated", fallback: "Bicycle road" },
  { colorKey: "permitted" as const, labelKey: "bicyclePermitted", fallback: "Permitted" },
] as const;

const POI_ITEMS = [
  { colorKey: "parking" as const, labelKey: "bikeParking", fallback: "Parking" },
  { colorKey: "shop" as const, labelKey: "bikeShop", fallback: "Shop" },
  { colorKey: "repair" as const, labelKey: "repairStation", fallback: "Repair" },
  { colorKey: "rental" as const, labelKey: "bikeRental", fallback: "Rental" },
] as const;

export function CyclingLegend() {
  const { t } = useTranslation();
  const panelOpen = useCyclingStore((s) => s.panelOpen);

  if (!panelOpen) return null;

  return (
    <Surface style={styles.container} elevation={3}>
      <Text style={styles.title}>
        {t("cycling.cyclingInfrastructure", "Cycling Infrastructure")}
      </Text>
      <View style={styles.row}>
        {LINE_ITEMS.map((item) => (
          <View key={item.colorKey} style={styles.item}>
            <View style={[styles.line, { backgroundColor: CYCLING_COLORS[item.colorKey] }]} />
            <Text style={styles.label}>{t(`cycling.${item.labelKey}`, item.fallback)}</Text>
          </View>
        ))}
      </View>
      <View style={[styles.row, { marginTop: 4 }]}>
        {POI_ITEMS.map((item) => (
          <View key={item.colorKey} style={styles.item}>
            <View style={[styles.dot, { backgroundColor: CYCLING_COLORS[item.colorKey] }]} />
            <Text style={styles.label}>{t(`cycling.${item.labelKey}`, item.fallback)}</Text>
          </View>
        ))}
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  title: {
    fontWeight: "600",
    fontSize: 13,
    marginBottom: 6,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  line: {
    width: 20,
    height: 3,
    borderRadius: 2,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#fff",
  },
  label: {
    fontSize: 11,
  },
});
