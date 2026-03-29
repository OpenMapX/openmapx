import { SAC_GRADES, useHikingStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Surface, Text } from "react-native-paper";

const GRADES = [
  "hiking",
  "mountain_hiking",
  "demanding_mountain_hiking",
  "alpine_hiking",
  "demanding_alpine_hiking",
  "difficult_alpine_hiking",
] as const;

const SHELTER_ITEMS = [
  { label: "Refuge", color: "#D84315" },
  { label: "Cabin", color: "#795548" },
  { label: "Guesthouse", color: "#5D4037" },
  { label: "Water", color: "#0288D1" },
] as const;

export function HikingTrailsLegend() {
  const { t } = useTranslation();
  const panelOpen = useHikingStore((s) => s.panelOpen);

  if (!panelOpen) return null;

  return (
    <Surface style={styles.container} elevation={3}>
      <Text style={styles.title}>{t("hiking.trailDifficulty", "Trail Difficulty")}</Text>
      <View style={styles.row}>
        {GRADES.map((key) => {
          const grade = SAC_GRADES[key];
          return (
            <View key={key} style={styles.gradeItem}>
              <View style={[styles.gradeLine, { backgroundColor: grade.color }]} />
              <Text style={styles.gradeLabel}>{grade.grade}</Text>
            </View>
          );
        })}
      </View>
      <View style={[styles.row, { marginTop: 4 }]}>
        {SHELTER_ITEMS.map((s) => (
          <View key={s.label} style={styles.shelterItem}>
            <View style={[styles.shelterDot, { backgroundColor: s.color }]} />
            <Text style={styles.label}>{s.label}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.attribution}>Waymarked Trails / OSM</Text>
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
  gradeItem: {
    alignItems: "center",
    gap: 3,
  },
  gradeLine: {
    width: 22,
    height: 4,
    borderRadius: 2,
  },
  gradeLabel: {
    fontSize: 9,
    textAlign: "center",
  },
  shelterItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  shelterDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#fff",
  },
  label: {
    fontSize: 10,
  },
  attribution: {
    fontSize: 9,
    color: "#999",
    marginTop: 4,
  },
});
