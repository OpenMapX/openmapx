import { MaterialIcons } from "@expo/vector-icons";
import type { ElevationStats as ElevationStatsType, Route } from "@openmapx/core";
import { useElevation } from "@openmapx/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Divider, Text } from "react-native-paper";
import { ElevationChart } from "./ElevationChart";

const TEAL = "#007b8b";

interface ElevationProfileProps {
  route: Route;
  units: "metric" | "imperial";
}

function formatElevation(metres: number, units: "metric" | "imperial"): string {
  if (units === "imperial") return `${Math.round(metres * 3.28084)} ft`;
  return `${Math.round(metres)} m`;
}

function ElevationStats({
  stats,
  units,
  compact = false,
}: {
  stats: ElevationStatsType;
  units: "metric" | "imperial";
  compact?: boolean;
}) {
  return (
    <View style={[styles.statsRow, compact && styles.statsRowCompact]}>
      <View style={styles.statItem}>
        <MaterialIcons name="arrow-upward" size={14} color="#4CAF50" />
        <Text style={styles.statValue}>+{formatElevation(stats.totalAscent, units)}</Text>
      </View>
      <View style={styles.statItem}>
        <MaterialIcons name="arrow-downward" size={14} color="#F44336" />
        <Text style={styles.statValue}>-{formatElevation(stats.totalDescent, units)}</Text>
      </View>
      {!compact && (
        <>
          <View style={styles.statItem}>
            <MaterialIcons name="landscape" size={14} color="#888" />
            <Text style={styles.statValue}>{formatElevation(stats.maxElevation, units)}</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.percentLabel}>%</Text>
            <Text style={styles.statValue}>{stats.averageGrade}%</Text>
          </View>
        </>
      )}
    </View>
  );
}

export function ElevationProfile({ route, units }: ElevationProfileProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  // Auto-expand for walking/cycling
  const shouldAutoExpand = route.mode !== "driving";

  const { data: profile, isLoading } = useElevation({
    route,
    enabled: expanded || shouldAutoExpand,
  });

  useEffect(() => {
    if (shouldAutoExpand && profile && profile.stats.totalAscent > 50) {
      setExpanded(true);
    }
  }, [shouldAutoExpand, profile]);

  if (!isLoading && !profile && expanded) return null;

  const hasData = profile && profile.points.length >= 2;

  return (
    <View>
      <Divider />
      <Pressable onPress={() => setExpanded((v) => !v)} style={styles.header}>
        <MaterialIcons name="terrain" size={18} color={TEAL} />
        <Text style={styles.title}>{t("elevation.title")}</Text>
        {hasData && !expanded && <ElevationStats stats={profile.stats} units={units} compact />}
        {isLoading && <ActivityIndicator size={14} color={TEAL} />}
        <MaterialIcons name={expanded ? "expand-less" : "expand-more"} size={18} color="#888" />
      </Pressable>
      {expanded && hasData && (
        <View style={styles.chartContainer}>
          <ElevationStats stats={profile.stats} units={units} />
          <ElevationChart
            points={profile.points}
            mode={route.mode as "driving" | "walking" | "cycling"}
            units={units}
          />
        </View>
      )}
      {expanded && isLoading && (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size={24} color={TEAL} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: "500",
    flex: 1,
    color: "#333",
  },
  chartContainer: {
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  loadingContainer: {
    alignItems: "center",
    paddingVertical: 16,
  },
  statsRow: {
    flexDirection: "row",
    gap: 16,
    flexWrap: "wrap",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingBottom: 6,
  },
  statsRowCompact: {
    gap: 12,
  },
  statItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  statValue: {
    fontSize: 12,
    fontWeight: "500",
    color: "#333",
  },
  percentLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#888",
  },
});
