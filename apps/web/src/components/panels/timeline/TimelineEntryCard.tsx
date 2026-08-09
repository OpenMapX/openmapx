"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import ListItemButton from "@mui/material/ListItemButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { PersonalTimelineDayV1 } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import type { Ref } from "react";

type TimelineEntry = PersonalTimelineDayV1["entries"][number];

interface TimelineEntryCardProps {
  entry: TimelineEntry;
  timeZone: string;
  selected: boolean;
  elementRef: Ref<HTMLButtonElement>;
  onSelect: () => void;
}

function number(value: number, locale: string, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

function durationFromMinutes(minutes: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "minute",
    unitDisplay: "short",
    maximumFractionDigits: 0,
  }).format(minutes);
}

function meters(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "meter",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value);
}

function durationFromSeconds(seconds: number, locale: string): string {
  return durationFromMinutes(Math.round(seconds / 60), locale);
}

export function TimelineEntryCard({
  entry,
  timeZone,
  selected,
  elementRef,
  onSelect,
}: TimelineEntryCardProps) {
  const t = useTranslations("timeline");
  const locale = useLocale();
  const clock = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const startEnd = `${clock.format(new Date(entry.startedAt))}–${clock.format(
    new Date(entry.endedAt),
  )}`;
  const name =
    entry.type === "visit"
      ? (entry.name ?? t("visitFallback"))
      : (entry.dominantMode ?? t("journeyFallback"));

  return (
    <ListItemButton
      ref={elementRef}
      component="button"
      type="button"
      data-entry-id={entry.id}
      aria-pressed={selected}
      onClick={onSelect}
      sx={{
        display: "block",
        minHeight: 88,
        p: 1.5,
        border: "2px solid",
        borderColor: selected ? "primary.main" : "divider",
        borderRadius: 2,
        bgcolor: selected ? "action.selected" : "background.paper",
        transition: "background-color 180ms ease, border-color 180ms ease",
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
        "&:focus-visible": { outline: "3px solid", outlineColor: "primary.main", outlineOffset: 2 },
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 650, lineHeight: 1.35 }}>
            {name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {startEnd} ·{" "}
            {entry.type === "visit"
              ? durationFromMinutes(entry.durationMinutes, locale)
              : durationFromSeconds(entry.durationSeconds, locale)}
          </Typography>
        </Box>
        {selected && (
          <Chip size="small" color="primary" icon={<CheckCircleIcon />} label={t("selected")} />
        )}
      </Stack>

      {entry.type === "visit" ? (
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 1, flexWrap: "wrap" }}>
          {entry.pointCount !== undefined && (
            <Chip
              size="small"
              label={`${t("pointCount")}: ${number(entry.pointCount, locale, 0)}`}
            />
          )}
          {entry.tags.map((tag) => (
            <Chip key={tag} size="small" variant="outlined" label={tag} />
          ))}
        </Stack>
      ) : (
        <Stack direction="row" spacing={0.75} useFlexGap sx={{ mt: 1, flexWrap: "wrap" }}>
          {entry.distance !== undefined && (
            <Chip size="small" label={`${number(entry.distance, locale)} ${entry.distanceUnit}`} />
          )}
          {entry.averageSpeed !== undefined && entry.speedUnit && (
            <Chip size="small" label={`${number(entry.averageSpeed, locale)} ${entry.speedUnit}`} />
          )}
          {entry.elevationGain !== undefined && (
            <Chip
              size="small"
              label={`${t("elevationGain")}: ${meters(entry.elevationGain, locale)}`}
            />
          )}
          {entry.elevationLoss !== undefined && (
            <Chip
              size="small"
              label={`${t("elevationLoss")}: ${meters(entry.elevationLoss, locale)}`}
            />
          )}
        </Stack>
      )}
    </ListItemButton>
  );
}
