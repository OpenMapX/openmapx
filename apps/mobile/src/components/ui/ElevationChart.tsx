import type { ElevationPoint } from "@openmapx/core";
import { computeGrades, downsampleLTTB } from "@openmapx/core";
import { Canvas, Path, Skia } from "@shopify/react-native-skia";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Text } from "react-native-paper";
import { useElevationHover } from "@/lib/ElevationHoverContext";

const CHART_HEIGHT = 140;
const CHART_PADDING_LEFT = 40;
const CHART_PADDING_RIGHT = 8;
const CHART_PADDING_TOP = 8;
const CHART_PADDING_BOTTOM = 20;

const GRADE_COLORS = [
  { threshold: 3, color: "#4CAF50" },
  { threshold: 6, color: "#8BC34A" },
  { threshold: 10, color: "#FFC107" },
  { threshold: 15, color: "#FF9800" },
  { threshold: 100, color: "#F44336" },
];

function gradeToColor(absGrade: number): string {
  for (const { threshold, color } of GRADE_COLORS) {
    if (absGrade <= threshold) return color;
  }
  return "#F44336";
}

interface ElevationChartProps {
  points: ElevationPoint[];
  mode: "driving" | "walking" | "cycling";
  units: "metric" | "imperial";
}

export function ElevationChart({ points, mode, units }: ElevationChartProps) {
  const { setDistance } = useElevationHover();
  const [chartWidth, setChartWidth] = useState(300);
  const [tooltip, setTooltip] = useState<{
    x: number;
    elevation: number;
    distance: number;
    grade: number;
  } | null>(null);

  // Downsample for chart rendering
  const displayPoints = useMemo(() => downsampleLTTB(points, 300), [points]);
  const grades = useMemo(() => computeGrades(points), [points]);

  // Build a lookup for distance -> original index for grade
  const distToIndex = useMemo(() => {
    const map = new Map<number, number>();
    for (let i = 0; i < points.length; i++) {
      map.set(points[i].distance, i);
    }
    return map;
  }, [points]);

  // Y-axis domain
  const [yMin, yMax] = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const p of displayPoints) {
      if (p.elevation < min) min = p.elevation;
      if (p.elevation > max) max = p.elevation;
    }
    const range = max - min;
    const padding = Math.max(range * 0.1, 20);
    return [Math.floor(min - padding), Math.ceil(max + padding)];
  }, [displayPoints]);

  const plotWidth = chartWidth - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  const plotHeight = CHART_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  const totalDist = displayPoints.length > 0 ? displayPoints[displayPoints.length - 1].distance : 1;

  const xScale = useCallback(
    (d: number) => CHART_PADDING_LEFT + (d / totalDist) * plotWidth,
    [totalDist, plotWidth],
  );

  const yScale = useCallback(
    (e: number) => CHART_PADDING_TOP + plotHeight - ((e - yMin) / (yMax - yMin)) * plotHeight,
    [yMin, yMax, plotHeight],
  );

  // Build the area path
  const { areaPath, linePath } = useMemo(() => {
    if (displayPoints.length < 2) {
      return { areaPath: null, linePath: null };
    }

    const line = Skia.Path.Make();
    const area = Skia.Path.Make();

    const x0 = xScale(displayPoints[0].distance);
    const y0 = yScale(displayPoints[0].elevation);

    line.moveTo(x0, y0);
    area.moveTo(x0, CHART_PADDING_TOP + plotHeight);
    area.lineTo(x0, y0);

    for (let i = 1; i < displayPoints.length; i++) {
      const x = xScale(displayPoints[i].distance);
      const y = yScale(displayPoints[i].elevation);
      line.lineTo(x, y);
      area.lineTo(x, y);
    }

    const lastX = xScale(displayPoints[displayPoints.length - 1].distance);
    area.lineTo(lastX, CHART_PADDING_TOP + plotHeight);
    area.close();

    return { areaPath: area, linePath: line };
  }, [displayPoints, xScale, yScale, plotHeight]);

  // Find nearest point for a given x position
  const findNearestPoint = useCallback(
    (touchX: number) => {
      const dist = ((touchX - CHART_PADDING_LEFT) / plotWidth) * totalDist;
      const clampedDist = Math.max(0, Math.min(totalDist, dist));

      let closest = displayPoints[0];
      let closestDiff = Math.abs(displayPoints[0].distance - clampedDist);
      for (let i = 1; i < displayPoints.length; i++) {
        const diff = Math.abs(displayPoints[i].distance - clampedDist);
        if (diff < closestDiff) {
          closest = displayPoints[i];
          closestDiff = diff;
        }
      }

      const origIdx = distToIndex.get(closest.distance) ?? 0;
      const grade = grades[origIdx] ?? 0;

      return {
        x: xScale(closest.distance),
        elevation: closest.elevation,
        distance: closest.distance,
        grade,
      };
    },
    [displayPoints, plotWidth, totalDist, xScale, distToIndex, grades],
  );

  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      const result = findNearestPoint(e.x);
      setTooltip(result);
      setDistance(result.distance);
    })
    .onEnd(() => {
      setTooltip(null);
      setDistance(null);
    })
    .onFinalize(() => {
      setTooltip(null);
      setDistance(null);
    });

  const tapGesture = Gesture.Tap().onEnd((e) => {
    const result = findNearestPoint(e.x);
    setTooltip(result);
    setDistance(result.distance);
    // Clear after a brief moment
    setTimeout(() => {
      setTooltip(null);
      setDistance(null);
    }, 2000);
  });

  const gesture = Gesture.Race(panGesture, tapGesture);

  // Y-axis tick labels (must be before early return to satisfy hook ordering rules)
  const yTicks = useMemo(() => {
    const range = yMax - yMin;
    const step = Math.max(1, 10 ** Math.floor(Math.log10(range / 3)));
    const ticks: number[] = [];
    let tick = Math.ceil(yMin / step) * step;
    while (tick <= yMax) {
      ticks.push(tick);
      tick += step;
    }
    return ticks.slice(0, 5);
  }, [yMin, yMax]);

  // X-axis tick labels
  const xTicks = useMemo(() => {
    const step = Math.max(1, 10 ** Math.floor(Math.log10(totalDist / 4)));
    const ticks: number[] = [];
    let tick = 0;
    while (tick <= totalDist) {
      ticks.push(tick);
      tick += step;
    }
    return ticks.slice(0, 5);
  }, [totalDist]);

  if (displayPoints.length < 2 || !areaPath || !linePath) return null;

  const isDriving = mode === "driving";
  const fillColor = isDriving ? "#1A73E8" : "#4CAF50";
  const strokeColor = isDriving ? "#1A73E8" : "#4CAF50";

  // Format helpers
  const formatElev = (e: number) =>
    units === "imperial" ? `${Math.round(e * 3.28084)} ft` : `${Math.round(e)} m`;

  const formatDist = (d: number) =>
    units === "imperial"
      ? `${(d / 1609.34).toFixed(1)} mi`
      : d >= 1000
        ? `${(d / 1000).toFixed(1)} km`
        : `${Math.round(d)} m`;

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.container} onLayout={(e) => setChartWidth(e.nativeEvent.layout.width)}>
        <Canvas style={{ width: chartWidth, height: CHART_HEIGHT }}>
          {/* Area fill */}
          <Path path={areaPath} color={fillColor} opacity={0.15} />

          {/* Line stroke */}
          <Path
            path={linePath}
            color={strokeColor}
            style="stroke"
            strokeWidth={2}
            strokeJoin="round"
            strokeCap="round"
          />

          {/* Cursor line */}
          {tooltip && (
            <Path
              path={(() => {
                const p = Skia.Path.Make();
                p.moveTo(tooltip.x, CHART_PADDING_TOP);
                p.lineTo(tooltip.x, CHART_PADDING_TOP + plotHeight);
                return p;
              })()}
              color="#999"
              style="stroke"
              strokeWidth={1}
            />
          )}
        </Canvas>

        {/* Y-axis labels */}
        {yTicks.map((tick) => (
          <Text
            key={`y-${tick}`}
            style={[
              styles.axisLabel,
              {
                position: "absolute",
                left: 0,
                top: yScale(tick) - 6,
                width: CHART_PADDING_LEFT - 4,
                textAlign: "right",
              },
            ]}
          >
            {units === "imperial" ? `${Math.round(tick * 3.28084)}` : `${Math.round(tick)}`}
          </Text>
        ))}

        {/* X-axis labels */}
        {xTicks.map((tick) => (
          <Text
            key={`x-${tick}`}
            style={[
              styles.axisLabel,
              {
                position: "absolute",
                left: xScale(tick) - 20,
                bottom: 0,
                width: 40,
                textAlign: "center",
              },
            ]}
          >
            {formatDist(tick)}
          </Text>
        ))}

        {/* Tooltip */}
        {tooltip && (
          <View
            style={[
              styles.tooltip,
              {
                left: Math.min(tooltip.x + 8, chartWidth - 100),
                top: CHART_PADDING_TOP,
              },
            ]}
          >
            <Text style={styles.tooltipBold}>{formatElev(tooltip.elevation)}</Text>
            <Text style={styles.tooltipSecondary}>{formatDist(tooltip.distance)}</Text>
            <Text style={[styles.tooltipGrade, { color: gradeToColor(Math.abs(tooltip.grade)) }]}>
              {tooltip.grade >= 0 ? "+" : ""}
              {tooltip.grade.toFixed(1)}%
            </Text>
          </View>
        )}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    height: CHART_HEIGHT,
    position: "relative",
  },
  axisLabel: {
    fontSize: 9,
    color: "#999",
  },
  tooltip: {
    position: "absolute",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e0e0e0",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
  },
  tooltipBold: {
    fontSize: 12,
    fontWeight: "600",
    color: "#333",
  },
  tooltipSecondary: {
    fontSize: 11,
    color: "#888",
  },
  tooltipGrade: {
    fontSize: 11,
  },
});
