"use client";

import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import Typography from "@mui/material/Typography";
import { useVehicleJourney } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";

interface TransitLegStopsProps {
  tripId?: string;
  /** Number of intermediate stops between from/to — shown before expansion. */
  stopCount?: number;
  /** Stop ID where we board — used to slice the full journey to this leg only. */
  fromStopId?: string;
  /** Stop ID where we alight — used to slice the full journey to this leg only. */
  toStopId?: string;
}

export function TransitLegStops({ tripId, stopCount, fromStopId, toStopId }: TransitLegStopsProps) {
  const tc = useTranslations("common");
  const fmt = useDateTimeFormat();
  const [expanded, setExpanded] = useState(false);
  // Fetch eagerly — React Query deduplicates with any other useVehicleJourney(tripId) call
  const { data: journey } = useVehicleJourney(tripId ?? null);

  if (!tripId) return null;

  // Slice the full vehicle journey to only the stops for this leg.
  // For circular routes (Ringlinie), a stop ID can appear multiple times.
  // Always search for the to-stop AFTER the from-stop to get the correct segment.
  const allStops = journey?.stops ?? [];
  const fromIdx = fromStopId ? allStops.findIndex((s) => s.stopId === fromStopId) : -1;
  const toIdx =
    fromIdx !== -1 && toStopId
      ? allStops.findIndex((s, i) => i > fromIdx && s.stopId === toStopId)
      : toStopId
        ? allStops.findIndex((s) => s.stopId === toStopId)
        : -1;
  const legStops =
    fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx
      ? allStops.slice(fromIdx, toIdx + 1)
      : allStops;

  const intermediateStops = legStops.slice(1, -1);

  // Use actual intermediate count from journey when available, otherwise fall back to planning.
  // Add 1 so the label counts the exit stop: "1 stop" = direct (board → exit, no stops in between).
  const rawCount = journey != null ? intermediateStops.length : stopCount;
  const count = rawCount != null ? rawCount + 1 : null;

  // No count info available at all → hide.
  if (count == null) return null;

  const label = tc("stopsCount", { count });
  const hasStops = journey != null && intermediateStops.length > 0;

  // Journey hasn't loaded yet but planning reports stops — show non-expandable count.
  if (!hasStops) {
    return (
      <Box sx={{ mt: 0.5 }}>
        <Typography
          variant="caption"
          sx={{
            color: "text.disabled",
          }}
        >
          {label}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 0.5 }}>
      <Box
        onClick={() => setExpanded((e) => !e)}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.25,
          cursor: "pointer",
          color: "text.secondary",
          userSelect: "none",
          "&:hover": { color: "text.primary" },
        }}
      >
        {expanded ? (
          <ExpandLessIcon sx={{ fontSize: 14 }} />
        ) : (
          <ExpandMoreIcon sx={{ fontSize: 14 }} />
        )}
        <Typography variant="caption">{label}</Typography>
      </Box>
      <Collapse in={expanded}>
        <Box sx={{ mt: 0.25, mb: 0.25 }}>
          {intermediateStops.map((stop, i) => {
            // Show realtime (delay-adjusted) time when available, fall back to scheduled
            const time =
              stop.expectedDeparture ??
              stop.expectedArrival ??
              stop.scheduledDeparture ??
              stop.scheduledArrival;
            const timeStr = time ? fmt.time(time) : "";
            const delaySec = stop.delaySeconds ?? 0;
            const delayMin = Math.round(delaySec / 60);

            return (
              <Box
                // biome-ignore lint/suspicious/noArrayIndexKey: intermediate stops ordered by sequence
                key={i}
                sx={{ display: "flex", alignItems: "center", gap: 0.75, py: 0.2 }}
              >
                <Box sx={{ width: 48, textAlign: "right", flexShrink: 0 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      fontVariantNumeric: "tabular-nums",
                      color: delayMin > 0 ? "error.main" : "text.primary",
                      fontSize: "0.68rem",
                    }}
                  >
                    {timeStr}
                  </Typography>
                  {delayMin > 0 && !stop.canceled && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "error.main",
                        display: "block",
                        fontSize: "0.6rem",
                        fontWeight: 600,
                      }}
                    >
                      +{delayMin}m
                    </Typography>
                  )}
                </Box>
                <Typography
                  variant="caption"
                  color={stop.canceled ? "error.main" : "text.secondary"}
                  noWrap
                  sx={{ flex: 1 }}
                >
                  {stop.name}
                </Typography>
              </Box>
            );
          })}
        </Box>
      </Collapse>
    </Box>
  );
}
