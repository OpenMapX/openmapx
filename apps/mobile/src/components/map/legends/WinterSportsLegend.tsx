import { useWinterSportsStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Surface, Text } from "react-native-paper";

const DIFFICULTY_ITEMS = [
  { key: "novice", color: "#4CAF50", label: "Novice" },
  { key: "easy", color: "#2196F3", label: "Easy" },
  { key: "intermediate", color: "#F44336", label: "Intermediate" },
  { key: "advanced", color: "#212121", label: "Advanced" },
  { key: "expert", color: "#FF9800", label: "Expert" },
  { key: "freeride", color: "#FFEB3B", label: "Freeride" },
] as const;

export function WinterSportsLegend() {
  const { t } = useTranslation();
  const panelOpen = useWinterSportsStore((s) => s.panelOpen);

  if (!panelOpen) return null;

  return (
    <Surface style={styles.container} elevation={3}>
      <Text style={styles.title}>{t("winterSports.pisteDifficulty", "Piste Difficulty")}</Text>
      <View style={styles.row}>
        {DIFFICULTY_ITEMS.map((d) => (
          <View key={d.key} style={styles.item}>
            <View
              style={[
                styles.circle,
                {
                  backgroundColor: d.color,
                  borderWidth: d.key === "freeride" ? 1 : 0,
                  borderColor: d.key === "freeride" ? "#ccc" : "transparent",
                },
              ]}
            />
            <Text style={styles.label}>{t(`winterSports.${d.key}`, d.label)}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.attribution}>OpenSnowMap / OSM</Text>
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
    gap: 10,
  },
  item: {
    alignItems: "center",
    gap: 3,
  },
  circle: {
    width: 14,
    height: 14,
    borderRadius: 7,
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
