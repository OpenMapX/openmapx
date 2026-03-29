import { MaterialIcons } from "@expo/vector-icons";
import type { Route } from "@openmapx/core";
import { formatDistance, formatDuration } from "@openmapx/core";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";

const TEAL = "#007b8b";

interface RouteCardProps {
  route: Route;
  index: number;
  active: boolean;
  onSelect: () => void;
  onDetails: () => void;
  units: "metric" | "imperial";
}

export function RouteCard({ route, index, active, onSelect, onDetails, units }: RouteCardProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

  const iconName =
    route.mode === "driving"
      ? "directions-car"
      : route.mode === "walking"
        ? "directions-walk"
        : "directions-bike";

  return (
    <Pressable
      onPress={onSelect}
      style={[
        styles.container,
        {
          borderLeftColor: active ? TEAL : "transparent",
          backgroundColor: active ? "rgba(0,123,139,0.04)" : "transparent",
        },
      ]}
    >
      <View style={styles.iconCol}>
        <MaterialIcons
          name={iconName}
          size={22}
          color={active ? TEAL : theme.colors.onSurfaceDisabled}
        />
      </View>
      <View style={styles.contentCol}>
        <View style={styles.topRow}>
          <Text style={[styles.summary, { color: theme.colors.onSurface }]} numberOfLines={1}>
            {route.summary ?? t("directions.bestRoute")}
          </Text>
          <Text style={[styles.duration, { color: active ? TEAL : theme.colors.onSurface }]}>
            {formatDuration(route.duration)}
          </Text>
        </View>
        <Text style={[styles.distance, { color: theme.colors.onSurfaceVariant }]}>{dist}</Text>
        {active && index === 0 && (
          <Text style={[styles.fastest, { color: theme.colors.onSurfaceVariant }]}>
            {t("directions.fastestRoute")}
          </Text>
        )}
        {active && (
          <Pressable onPress={onDetails} hitSlop={8} style={styles.detailsButton}>
            <Text style={styles.detailsText}>{t("common.details")}</Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderLeftWidth: 4,
  },
  iconCol: {
    marginTop: 2,
  },
  contentCol: {
    flex: 1,
    minWidth: 0,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  summary: {
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
    marginRight: 8,
  },
  duration: {
    fontSize: 14,
    fontWeight: "600",
  },
  distance: {
    fontSize: 12,
    marginTop: 2,
  },
  fastest: {
    fontSize: 12,
    marginTop: 2,
  },
  detailsButton: {
    marginTop: 4,
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  detailsText: {
    fontSize: 12,
    fontWeight: "500",
    color: TEAL,
  },
});
