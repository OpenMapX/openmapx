import { MaterialIcons } from "@expo/vector-icons";
import type { LngLat } from "@openmapx/core";
import { formatArea, formatMeasurementDistance, useMeasurementStore } from "@openmapx/core";
import { area } from "@turf/area";
import { lineString, polygon as turfPolygon } from "@turf/helpers";
import { length } from "@turf/length";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Chip, Divider, IconButton, Surface, Text, useTheme } from "react-native-paper";

function computeTotalDistance(points: LngLat[]): number {
  if (points.length < 2) return 0;
  return length(lineString(points), { units: "meters" });
}

function computePolygonArea(points: LngLat[]): number {
  if (points.length < 3) return 0;
  const ring = [...points, points[0]];
  return area(turfPolygon([ring]));
}

function computePerimeter(points: LngLat[]): number {
  if (points.length < 3) return 0;
  const ring = [...points, points[0]];
  return length(lineString(ring), { units: "meters" });
}

export function MeasurementToolbar() {
  const { t } = useTranslation();
  const isActive = useMeasurementStore((s) => s.isActive);
  const mode = useMeasurementStore((s) => s.mode);
  const points = useMeasurementStore((s) => s.points);
  const undonePoints = useMeasurementStore((s) => s.undonePoints);
  const unitSystem = useMeasurementStore((s) => s.unitSystem);
  const isFinalized = useMeasurementStore((s) => s.isFinalized);
  const setMode = useMeasurementStore((s) => s.setMode);
  const setUnitSystem = useMeasurementStore((s) => s.setUnitSystem);
  const undo = useMeasurementStore((s) => s.undo);
  const redo = useMeasurementStore((s) => s.redo);
  const clear = useMeasurementStore((s) => s.clear);
  const deactivate = useMeasurementStore((s) => s.deactivate);

  const measurementText = useMemo(() => {
    if (mode === "line") {
      if (points.length < 2) return t("measurement.clickToStart");
      const dist = computeTotalDistance(points);
      return `${t("measurement.total")}: ${formatMeasurementDistance(dist, unitSystem)}`;
    }
    if (points.length < 3) return t("measurement.clickToStart");
    if (!isFinalized) return t("measurement.clickToClose");
    const a = computePolygonArea(points);
    const p = computePerimeter(points);
    return `${formatArea(a, unitSystem)} | ${t("measurement.perimeter")}: ${formatMeasurementDistance(p, unitSystem)}`;
  }, [points, mode, unitSystem, isFinalized, t]);

  if (!isActive) return null;

  return (
    <View pointerEvents="box-none" style={styles.wrapper}>
      <Surface style={styles.container} elevation={3}>
        {/* Top row: mode toggle, measurement text, unit toggle, close */}
        <View style={styles.topRow}>
          {/* Mode toggle */}
          <View style={styles.modeToggle}>
            <ModeButton
              icon="show-chart"
              active={mode === "line"}
              onPress={() => setMode("line")}
              label={t("measurement.lineMode")}
            />
            <ModeButton
              icon="timeline"
              active={mode === "polygon"}
              onPress={() => setMode("polygon")}
              label={t("measurement.polygonMode")}
            />
          </View>

          <Divider style={styles.verticalDivider} />

          {/* Unit toggle */}
          <View style={styles.unitToggle}>
            <Chip
              compact
              selected={unitSystem === "metric"}
              onPress={() => setUnitSystem("metric")}
              style={styles.unitChip}
              textStyle={styles.unitChipText}
            >
              km
            </Chip>
            <Chip
              compact
              selected={unitSystem === "imperial"}
              onPress={() => setUnitSystem("imperial")}
              style={styles.unitChip}
              textStyle={styles.unitChipText}
            >
              mi
            </Chip>
          </View>

          <Divider style={styles.verticalDivider} />

          {/* Action buttons */}
          <View style={styles.actions}>
            <IconButton
              icon={({ size, color }) => <MaterialIcons name="undo" size={size} color={color} />}
              size={18}
              onPress={undo}
              disabled={points.length === 0}
              accessibilityLabel={t("measurement.undo")}
              style={styles.actionButton}
            />
            <IconButton
              icon={({ size, color }) => <MaterialIcons name="redo" size={size} color={color} />}
              size={18}
              onPress={redo}
              disabled={undonePoints.length === 0}
              accessibilityLabel={t("measurement.redo")}
              style={styles.actionButton}
            />
            <IconButton
              icon={({ size, color }) => (
                <MaterialIcons name="delete-outline" size={size} color={color} />
              )}
              size={18}
              onPress={clear}
              disabled={points.length === 0}
              accessibilityLabel={t("measurement.clearMeasurement")}
              style={styles.actionButton}
            />
            <IconButton
              icon={({ size, color }) => <MaterialIcons name="close" size={size} color={color} />}
              size={18}
              onPress={deactivate}
              accessibilityLabel={t("measurement.closeTool")}
              style={styles.actionButton}
            />
          </View>
        </View>

        {/* Measurement display */}
        <Text variant="labelMedium" style={styles.measurementText}>
          {measurementText}
        </Text>
      </Surface>
    </View>
  );
}

function ModeButton({
  icon,
  active,
  onPress,
  label,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  active: boolean;
  onPress: () => void;
  label: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[styles.modeButton, active && { backgroundColor: theme.colors.secondaryContainer }]}
    >
      <MaterialIcons
        name={icon}
        size={20}
        color={active ? theme.colors.primary : theme.colors.onSurfaceVariant}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    bottom: 24,
    left: 12,
    right: 12,
    alignItems: "center",
  },
  container: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxWidth: 480,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  modeToggle: {
    flexDirection: "row",
    borderRadius: 8,
    overflow: "hidden",
  },
  modeButton: {
    width: 36,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  verticalDivider: {
    width: 1,
    height: 24,
    marginHorizontal: 4,
  },
  unitToggle: {
    flexDirection: "row",
    gap: 4,
  },
  unitChip: {
    height: 28,
  },
  unitChipText: {
    fontSize: 11,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
  },
  actionButton: {
    width: 32,
    height: 32,
    margin: 0,
  },
  measurementText: {
    textAlign: "center",
    fontWeight: "600",
    marginTop: 4,
  },
});
