import { MaterialIcons } from "@expo/vector-icons";
import type { Facility } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Chip, Text } from "react-native-paper";

const FACILITY_ICONS: Record<Facility["type"], keyof typeof MaterialIcons.glyphMap> = {
  elevator: "elevator",
  escalator: "escalator",
  bike_storage: "directions-bike",
  parking: "local-parking",
  other: "more-horiz",
};

interface FacilitiesSectionProps {
  facilities: Facility[];
}

export function FacilitiesSection({ facilities }: FacilitiesSectionProps) {
  const { t } = useTranslation();
  if (facilities.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t("transit.facilities")}</Text>
      <View style={styles.chipRow}>
        {facilities.map((f) => (
          <Chip
            key={f.id}
            icon={() => <MaterialIcons name={FACILITY_ICONS[f.type]} size={16} color="#666" />}
            compact
            mode="outlined"
            style={styles.chip}
            textStyle={styles.chipText}
          >
            {f.name}
          </Chip>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  chip: {
    height: 32,
  },
  chipText: {
    fontSize: 12,
  },
});
