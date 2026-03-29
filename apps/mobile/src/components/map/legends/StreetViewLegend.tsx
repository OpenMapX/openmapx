import { useStreetViewStore } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Surface, Text } from "react-native-paper";

export function StreetViewLegend() {
  const { t } = useTranslation();
  const panelOpen = useStreetViewStore((s) => s.panelOpen);

  if (!panelOpen) return null;

  return (
    <Surface style={styles.container} elevation={3}>
      <Text style={styles.title}>{t("streetView.coverage", "Coverage")}</Text>
      <View style={styles.row}>
        <View style={styles.item}>
          <View style={[styles.line, { backgroundColor: "#03a9f4" }]} />
          <Text style={styles.label}>{t("layers.streetLevelImagery", "Street imagery")}</Text>
        </View>
        <View style={styles.item}>
          <View style={styles.panoCircle} />
          <Text style={styles.label}>{t("streetView.photo360", "360\u00B0 photo")}</Text>
        </View>
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
    gap: 16,
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
  panoCircle: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#03a9f4",
    backgroundColor: "rgba(3,169,244,0.15)",
  },
  label: {
    fontSize: 11,
  },
});
