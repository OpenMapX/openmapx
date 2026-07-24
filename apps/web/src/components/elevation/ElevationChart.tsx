"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ElevationPoint } from "@openmapx/core";
import { computeGrades, downsampleLTTB } from "@openmapx/core";
import { useCallback, useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useElevationHover } from "./ElevationHoverContext";

interface ElevationChartProps {
  points: ElevationPoint[];
  mode: "driving" | "walking" | "cycling";
  units: "metric" | "imperial";
}

interface ChartDatum {
  distance: number;
  elevation: number;
  originalIndex: number;
}

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

function CustomTooltip({
  active,
  payload,
  units,
  grades,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartDatum }>;
  units: "metric" | "imperial";
  grades: number[];
}) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const grade = grades[d.originalIndex] ?? 0;

  const elev =
    units === "imperial"
      ? `${Math.round(d.elevation * 3.28084)} ft`
      : `${Math.round(d.elevation)} m`;
  const dist =
    units === "imperial"
      ? `${(d.distance / 1609.34).toFixed(1)} mi`
      : d.distance >= 1000
        ? `${(d.distance / 1000).toFixed(1)} km`
        : `${Math.round(d.distance)} m`;

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "6px",
        px: 1.25,
        py: 0.75,
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      }}
    >
      <Typography
        variant="caption"
        sx={{
          fontWeight: 600,
          display: "block",
        }}
      >
        {elev}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          display: "block",
        }}
      >
        {dist}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          display: "block",
          color: gradeToColor(Math.abs(grade)),
        }}
      >
        {grade >= 0 ? "+" : ""}
        {grade.toFixed(1)}%
      </Typography>
    </Box>
  );
}

export function ElevationChart({ points, mode, units }: ElevationChartProps) {
  const { setHoveredIndex } = useElevationHover();

  // Downsample for chart rendering (max 600 points)
  const displayPoints = useMemo(() => downsampleLTTB(points, 600), [points]);

  // Pre-build a lookup from display point distance to original index (avoids O(n*m) indexOf)
  const chartData = useMemo<ChartDatum[]>(() => {
    const distToIndex = new Map<number, number>();
    for (let i = 0; i < points.length; i++) {
      distToIndex.set(points[i].distance, i);
    }
    return displayPoints.map((p) => ({
      distance: p.distance,
      elevation: p.elevation,
      originalIndex: distToIndex.get(p.distance) ?? 0,
    }));
  }, [displayPoints, points]);

  const grades = useMemo(() => computeGrades(points), [points]);

  // Build gradient stops based on slope steepness
  const gradientStops = useMemo(() => {
    if (mode === "driving" || chartData.length < 2) return null;
    const totalDist = chartData[chartData.length - 1].distance;
    if (totalDist <= 0) return null;

    const stops: Array<{ offset: string; color: string }> = [];
    for (const d of chartData) {
      const grade = grades[d.originalIndex] ?? 0;
      const pct = ((d.distance / totalDist) * 100).toFixed(1);
      stops.push({ offset: `${pct}%`, color: gradeToColor(Math.abs(grade)) });
    }
    return stops;
  }, [chartData, grades, mode]);

  // Y-axis domain with padding
  const [yMin, yMax] = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const p of chartData) {
      if (p.elevation < min) min = p.elevation;
      if (p.elevation > max) max = p.elevation;
    }
    const range = max - min;
    const padding = Math.max(range * 0.1, 20);
    return [Math.floor(min - padding), Math.ceil(max + padding)];
  }, [chartData]);

  const showSeaLevel = yMin <= 0 && yMax >= 0;

  const handleMouseMove = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: Recharts event type varies across versions
    (state: any) => {
      const idx = state?.activeTooltipIndex;
      if (idx != null && idx >= 0 && idx < chartData.length) {
        setHoveredIndex(chartData[idx].originalIndex);
      }
    },
    [chartData, setHoveredIndex],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredIndex(null);
  }, [setHoveredIndex]);

  const formatXAxis = useCallback(
    (value: number) => {
      if (units === "imperial") return `${(value / 1609.34).toFixed(1)} mi`;
      return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
    },
    [units],
  );

  const formatYAxis = useCallback(
    (value: number) => {
      if (units === "imperial") return `${Math.round(value * 3.28084)}`;
      return `${Math.round(value)}`;
    },
    [units],
  );

  if (chartData.length < 2) return null;

  const isDrivingMode = mode === "driving";

  return (
    <Box sx={{ width: "100%", height: 160, minWidth: 0 }}>
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart
          data={chartData}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
        >
          <defs>
            {isDrivingMode ? (
              <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1A73E8" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#1A73E8" stopOpacity={0.05} />
              </linearGradient>
            ) : gradientStops ? (
              <linearGradient id="elevFill" x1="0" y1="0" x2="1" y2="0">
                {gradientStops.map((s, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: gradient stops are positional
                  <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={0.5} />
                ))}
              </linearGradient>
            ) : (
              <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4CAF50" stopOpacity={0.4} />
                <stop offset="100%" stopColor="#4CAF50" stopOpacity={0.05} />
              </linearGradient>
            )}
            {isDrivingMode ? (
              <linearGradient id="elevStroke" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1A73E8" />
                <stop offset="100%" stopColor="#1A73E8" />
              </linearGradient>
            ) : gradientStops ? (
              <linearGradient id="elevStroke" x1="0" y1="0" x2="1" y2="0">
                {gradientStops.map((s, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: gradient stops are positional
                  <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={1} />
                ))}
              </linearGradient>
            ) : (
              <linearGradient id="elevStroke" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4CAF50" />
                <stop offset="100%" stopColor="#4CAF50" />
              </linearGradient>
            )}
          </defs>
          <CartesianGrid horizontal vertical={false} strokeDasharray="3 3" stroke="#E0E0E0" />
          <XAxis
            dataKey="distance"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={formatXAxis}
            tick={{ fontSize: 10, fill: "#999" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[yMin, yMax]}
            tickFormatter={formatYAxis}
            tick={{ fontSize: 10, fill: "#999" }}
            axisLine={false}
            tickLine={false}
            width={40}
            unit={units === "imperial" ? " ft" : " m"}
          />
          <Tooltip
            content={<CustomTooltip units={units} grades={grades} />}
            cursor={{ stroke: "#999", strokeDasharray: "3 3" }}
          />
          {showSeaLevel && (
            <ReferenceLine y={0} stroke="#90CAF9" strokeDasharray="4 4" strokeWidth={1} />
          )}
          <Area
            type="monotone"
            dataKey="elevation"
            stroke="url(#elevStroke)"
            strokeWidth={2}
            fill="url(#elevFill)"
            dot={false}
            activeDot={{ r: 4, fill: "var(--omx-brand)", stroke: "#fff", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </Box>
  );
}
