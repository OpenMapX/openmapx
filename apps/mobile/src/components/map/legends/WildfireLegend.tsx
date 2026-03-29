import { useWildfireStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Surface, Text } from "react-native-paper";

const RECENCY_LEGEND = [
  { label: "< 1h", color: "#ef4444" },
  { label: "1-6h", color: "#f97316" },
  { label: "6-12h", color: "#fb923c" },
  { label: "12-24h", color: "#fbbf24" },
  { label: "1-2d", color: "#fcd34d" },
  { label: "2-3d", color: "#fde68a" },
] as const;

const FRP_SIZES = [
  { label: "< 10", size: 5 },
  { label: "50", size: 10 },
  { label: "500+", size: 18 },
] as const;

export function WildfireLegend() {
  const { t } = useTranslation();
  const panelOpen = useWildfireStore((s) => s.panelOpen);

  if (!panelOpen) return null;

  return (
    <Surface style={styles.container} elevation={3}>
      <Text style={styles.title}>{t("layers.wildfires", "Wildfires")}</Text>
      <View style={styles.section}>
        <Text style={styles.subtitle}>Recency</Text>
        <View style={styles.row}>
          {RECENCY_LEGEND.map((r) => (
            <View key={r.label} style={styles.item}>
              <View style={[styles.swatch, { backgroundColor: r.color }]} />
              <Text style={styles.label}>{r.label}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={styles.section}>
        <Text style={styles.subtitle}>FRP (MW)</Text>
        <View style={styles.magRow}>
          {FRP_SIZES.map((f) => (
            <View key={f.label} style={styles.magItem}>
              <View
                style={[
                  styles.magCircle,
                  {
                    width: f.size,
                    height: f.size,
                    borderRadius: f.size / 2,
                  },
                ]}
              />
              <Text style={styles.label}>{f.label}</Text>
            </View>
          ))}
        </View>
      </View>
      <Text style={styles.attribution}>NASA FIRMS (CC0)</Text>
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
