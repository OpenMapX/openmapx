import { useEarthquakeStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Surface, Text } from "react-native-paper";

const DEPTH_LEGEND = [
  { label: "0-33 km", color: "#ff4500" },
  { label: "33-70", color: "#ff8c00" },
  { label: "70-150", color: "#ffd700" },
  { label: "150-300", color: "#32cd32" },
  { label: "300+", color: "#1e90ff" },
] as const;

const RECENCY_LEGEND = [
  { label: "< 1h", color: "#ef4444" },
  { label: "1-24h", color: "#f97316" },
  { label: "1-7d", color: "#eab308" },
  { label: "7d+", color: "#94a3b8" },
] as const;

const MAG_SIZES = [
  { label: "M2", size: 6 },
  { label: "M5", size: 14 },
  { label: "M7+", size: 24 },
] as const;

export function EarthquakeLegend() {
  const { t } = useTranslation();
  const panelOpen = useEarthquakeStore((s) => s.panelOpen);
  const colorMode = useEarthquakeStore((s) => s.colorMode);

  if (!panelOpen) return null;

  const colorScale = colorMode === "depth" ? DEPTH_LEGEND : RECENCY_LEGEND;

  return (
    <Surface style={styles.container} elevation={3}>
      <Text style={styles.title}>{t("layers.earthquakes", "Earthquakes")}</Text>
      <View style={styles.section}>
        <Text style={styles.subtitle}>{colorMode === "depth" ? "Depth" : "Recency"}</Text>
        <View style={styles.row}>
          {colorScale.map((d) => (
            <View key={d.label} style={styles.item}>
              <View style={[styles.swatch, { backgroundColor: d.color }]} />
              <Text style={styles.label}>{d.label}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={styles.section}>
        <Text style={styles.subtitle}>Magnitude</Text>
        <View style={styles.magRow}>
          {MAG_SIZES.map((m) => (
            <View key={m.label} style={styles.magItem}>
              <View
                style={[
                  styles.magCircle,
                  {
                    width: m.size,
                    height: m.size,
                    borderRadius: m.size / 2,
                  },
                ]}
              />
              <Text style={styles.label}>{m.label}</Text>
            </View>
          ))}
        </View>
      </View>
      <Text style={styles.attribution}>USGS Earthquake Hazards</Text>
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
    marginBottom: 4,
  },
  section: {
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 10,
    color: "#666",
    marginBottom: 2,
  },
  row: {
    flexDirection: "row",
    gap: 6,
  },
  item: {
    alignItems: "center",
    gap: 2,
  },
  swatch: {
    width: 18,
    height: 10,
    borderRadius: 2,
  },
  label: {
    fontSize: 9,
  },
  magRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-end",
  },
  magItem: {
    alignItems: "center",
    gap: 2,
  },
  magCircle: {
    backgroundColor: "#ef4444",
  },
  attribution: {
    fontSize: 9,
    color: "#999",
    marginTop: 2,
  },
});
