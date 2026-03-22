"use client";

import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import LandscapeIcon from "@mui/icons-material/Landscape";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ElevationStats as ElevationStatsType } from "@openmapx/core";

interface ElevationStatsProps {
  stats: ElevationStatsType;
  units: "metric" | "imperial";
  compact?: boolean;
}

function formatElevation(metres: number, units: "metric" | "imperial"): string {
  if (units === "imperial") return `${Math.round(metres * 3.28084)} ft`;
  return `${Math.round(metres)} m`;
}

interface StatItemProps {
  icon: React.ReactNode;
  value: string;
  color?: string;
}

function StatItem({ icon, value, color }: StatItemProps) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Box sx={{ display: "flex", color: color ?? "text.secondary", fontSize: 14 }}>{icon}</Box>
      <Typography variant="caption" fontWeight={500} color="text.primary">
        {value}
      </Typography>
    </Box>
  );
}

export function ElevationStats({ stats, units, compact = false }: ElevationStatsProps) {
  return (
    <Box sx={{ display: "flex", gap: compact ? 1.5 : 2, flexWrap: "wrap", alignItems: "center" }}>
      <StatItem
        icon={<ArrowUpwardIcon sx={{ fontSize: 14 }} />}
        value={`+${formatElevation(stats.totalAscent, units)}`}
        color="#4CAF50"
      />
      <StatItem
        icon={<ArrowDownwardIcon sx={{ fontSize: 14 }} />}
        value={`-${formatElevation(stats.totalDescent, units)}`}
        color="#F44336"
      />
      {!compact && (
        <>
          <StatItem
            icon={<LandscapeIcon sx={{ fontSize: 14 }} />}
            value={`${formatElevation(stats.maxElevation, units)}`}
          />
          <StatItem
            icon={
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontSize: 10, fontWeight: 700 }}
              >
                %
              </Typography>
            }
            value={`${stats.averageGrade}%`}
          />
        </>
      )}
    </Box>
  );
}
