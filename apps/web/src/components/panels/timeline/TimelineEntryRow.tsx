"use client";

import type { SvgIconComponent } from "@mui/icons-material";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsBoatIcon from "@mui/icons-material/DirectionsBoat";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsRunIcon from "@mui/icons-material/DirectionsRun";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import FlightIcon from "@mui/icons-material/Flight";
import PlaceIcon from "@mui/icons-material/Place";
import RouteIcon from "@mui/icons-material/Route";
import TrainIcon from "@mui/icons-material/Train";
import TwoWheelerIcon from "@mui/icons-material/TwoWheeler";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { PersonalTimelineDayV1 } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import type { Ref } from "react";
import { type RailSegment, TimelineRow } from "@/components/ui/TimelineRail";
import { BRAND } from "@/integration-api/runtime/theme";

export type TimelineEntry = PersonalTimelineDayV1["entries"][number];

/** How each of Dawarich's travel modes is named and drawn. */
const MODES: Record<string, { Icon: SvgIconComponent; onFoot?: boolean }> = {
  walking: { Icon: DirectionsWalkIcon, onFoot: true },
  running: { Icon: DirectionsRunIcon, onFoot: true },
  cycling: { Icon: DirectionsBikeIcon },
  driving: { Icon: DirectionsCarIcon },
  bus: { Icon: DirectionsBusIcon },
  train: { Icon: TrainIcon },
  flying: { Icon: FlightIcon },
  boat: { Icon: DirectionsBoatIcon },
  motorcycle: { Icon: TwoWheelerIcon },
};

const ON_FOOT: RailSegment = { color: "#9E9E9E", dotted: true };
const RIDDEN: RailSegment = { color: BRAND, dotted: false };

/** How a journey is drawn on the rail: dots on foot, a line otherwise. */
export function journeySegment(entry: TimelineEntry | undefined): RailSegment | undefined {
  if (entry?.type !== "journey") return undefined;
  return MODES[entry.dominantMode ?? ""]?.onFoot ? ON_FOOT : RIDDEN;
}

interface TimelineEntryRowProps {
  entry: TimelineEntry;
  /** The journeys either side of a visit, which the rail joins through it. */
  before?: TimelineEntry;
  after?: TimelineEntry;
  divider: boolean;
  timeZone: string;
  selected: boolean;
  elementRef: Ref<HTMLButtonElement>;
  onSelect: () => void;
}

/**
 * One entry of the day on the rail: a visit as a pin with its place and hours,
 * a journey as the stretch of rail between them with how it was travelled.
 * The row is a button that selects the entry on the map.
 */
export function TimelineEntryRow({
  entry,
  before,
  after,
  divider,
  timeZone,
  selected,
  elementRef,
  onSelect,
}: TimelineEntryRowProps) {
  const t = useTranslations("timeline");
  const locale = useLocale();
  const clock = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone });
  const start = clock.format(new Date(entry.startedAt));
  const end = clock.format(new Date(entry.endedAt));
  const minutes = new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "minute",
    unitDisplay: "short",
    maximumFractionDigits: 0,
  });
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

  let row: React.ReactNode;
  if (entry.type === "visit") {
    row = (
      <TimelineRow
        above={journeySegment(before)}
        below={journeySegment(after)}
        divider={divider}
        node={
          <Box
            sx={{
              display: "flex",
              p: 0.5,
              borderRadius: "50%",
              bgcolor: BRAND,
              color: "#fff",
              border: "2px solid",
              borderColor: "background.paper",
            }}
          >
            <PlaceIcon sx={{ fontSize: 18 }} />
          </Box>
        }
      >
        <Typography sx={{ fontWeight: 500, lineHeight: 1.5 }}>
          {entry.name ?? t("visitFallback")}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {`${start}–${end} · ${minutes.format(entry.durationMinutes)}`}
        </Typography>
        {entry.tags.length > 0 && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {entry.tags.join(" · ")}
          </Typography>
        )}
      </TimelineRow>
    );
  } else {
    const mode = MODES[entry.dominantMode ?? ""];
    const Icon = mode?.Icon ?? RouteIcon;
    const label = mode ? t(`modes.${entry.dominantMode}`) : t("journeyFallback");
    const parts = [label, minutes.format(Math.round(entry.durationSeconds / 60))];
    if (entry.distance !== undefined)
      parts.push(`${number.format(entry.distance)} ${entry.distanceUnit}`);
    const climb = [
      entry.elevationGain ? `${t("elevationGain")} ${number.format(entry.elevationGain)} m` : null,
      entry.elevationLoss ? `${t("elevationLoss")} ${number.format(entry.elevationLoss)} m` : null,
    ].filter(Boolean);
    row = (
      <TimelineRow
        through={journeySegment(entry)}
        divider={divider}
        node={
          <Box sx={{ display: "flex", p: 0.25, borderRadius: "50%", bgcolor: "background.paper" }}>
            <Icon sx={{ fontSize: 20, color: "text.secondary" }} />
          </Box>
        }
      >
        <Typography variant="body2" sx={{ color: "text.secondary", py: 0.5 }}>
          {parts.join(" · ")}
          {climb.length > 0 && ` · ${climb.join(" · ")}`}
        </Typography>
      </TimelineRow>
    );
  }

  return (
    <ButtonBase
      ref={elementRef}
      data-entry-id={entry.id}
      aria-pressed={selected}
      onClick={onSelect}
      sx={{
        display: "block",
        width: "100%",
        textAlign: "start",
        borderRadius: 2,
        bgcolor: selected ? "action.selected" : "transparent",
        transition: "background-color 180ms ease",
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
        "&:hover": { bgcolor: selected ? "action.selected" : "action.hover" },
        "&.Mui-focusVisible": {
          outline: "3px solid",
          outlineColor: "primary.main",
          outlineOffset: -3,
        },
      }}
    >
      {row}
    </ButtonBase>
  );
}
