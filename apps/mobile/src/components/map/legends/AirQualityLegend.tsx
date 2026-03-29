import { useAirQualityStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Surface, Text } from "react-native-paper";

const AQI_LEVELS = [
  { key: "good", color: "#009966", label: "Good" },
  { key: "moderate", color: "#ffde33", label: "Moderate" },
  { key: "unhealthyForSome", color: "#ff9933", label: "Sensitive" },
  { key: "unhealthy", color: "#cc0033", label: "Unhealthy" },
  { key: "veryUnhealthy", color: "#660099", label: "Very unhealthy" },
  { key: "hazardous", color: "#7e0023", label: "Hazardous" },
] as const;

export function AirQualityLegend() {
  const { t } = useTranslation();
  const panelOpen = useAirQualityStore((s) => s.panelOpen);

  if (!panelOpen) return null;

  return (
    <Surface style={styles.container} elevation={3}>
      <Text style={styles.title}>{t("airQuality.airQualityIndex", "Air Quality Index")}</Text>
      <View style={styles.row}>
        {AQI_LEVELS.map((level) => (
          <View key={level.key} style={styles.item}>
            <View style={[styles.swatch, { backgroundColor: level.color }]} />
            <Text style={styles.label}>{t(`airQuality.${level.key}`, level.label)}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.attribution}>OpenAQ (CC BY 4.0)</Text>
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
    gap: 8,
  },
  item: {
    alignItems: "center",
    gap: 3,
  },
  swatch: {
    width: 28,
    height: 14,
    borderRadius: 3,
  },
  label: {
    fontSize: 9,
    textAlign: "center",
  },
  attribution: {
    fontSize: 9,
    color: "#999",
    marginTop: 4,
  },
});
