import { MaterialIcons } from "@expo/vector-icons";
import type { TripRemark } from "@openmapx/core";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

const REMARK_CONFIG: Record<
  TripRemark["type"],
  {
    icon: keyof typeof MaterialIcons.glyphMap;
    bg: string;
    border: string;
    color: string;
  }
> = {
  info: {
    icon: "info-outline",
    bg: "#F5F5F5",
    border: "#BDBDBD",
    color: "#616161",
  },
  warning: {
    icon: "report-problem",
    bg: "#FFF8E1",
    border: "#FFE082",
    color: "#E65100",
  },
  cancellation: {
    icon: "cancel",
    bg: "#FFEBEE",
    border: "#EF9A9A",
    color: "#B71C1C",
  },
};

export const REMARK_PRIORITY: Record<TripRemark["type"], number> = {
  cancellation: 2,
  warning: 1,
  info: 0,
};

interface RemarkChipProps {
  remark: TripRemark;
  inline?: boolean;
}

export function RemarkChip({ remark, inline = false }: RemarkChipProps) {
  const config = REMARK_CONFIG[remark.type];

  if (inline) {
    return (
      <View style={styles.inlineRow}>
        <MaterialIcons
          name={config.icon}
          size={12}
          color={config.color}
          style={styles.inlineIcon}
        />
        <Text style={[styles.inlineText, { color: config.color }]}>{remark.text}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.chip, { backgroundColor: config.bg, borderLeftColor: config.border }]}>
      <MaterialIcons name={config.icon} size={15} color={config.color} style={styles.chipIcon} />
      <Text style={[styles.chipText, { color: config.color }]}>{remark.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  inlineRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 4,
  },
  inlineIcon: {
    marginTop: 1,
  },
  inlineText: {
    fontSize: 11,
    lineHeight: 15,
    flex: 1,
  },
  chip: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderLeftWidth: 3,
    borderTopRightRadius: 6,
    borderBottomRightRadius: 6,
  },
  chipIcon: {
    marginTop: 1,
  },
  chipText: {
    fontSize: 12,
    lineHeight: 17,
    flex: 1,
  },
});
