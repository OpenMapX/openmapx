"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  formatInTimeZone,
  timeZoneAt,
  tzDiffMinutes,
  tzOffsetLabel,
  viewerTimeZone,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

interface Props {
  lat: number;
  lng: number;
}

function formatLead(t: (key: string, values?: Record<string, string>) => string, minutes: number) {
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  const span = remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
  return t(minutes > 0 ? "ahead" : "behind", { span });
}

/**
 * Local clock for a place, shown only when its zone differs from the
 * viewer's — a place around the corner adds no row. `timeZoneAt` is a
 * synchronous point-in-polygon lookup, so there is no loading state.
 */
export function PlaceLocalTime({ lat, lng }: Props) {
  const t = useTranslations("localTime");
  // Memoize the lookup the same way PlaceHeaderWeather does, so it isn't
  // recomputed on every render.
  const zone = useMemo(() => timeZoneAt(lat, lng), [lat, lng]);

  const viewer = viewerTimeZone();
  if (!zone || zone === viewer) return null;

  const now = new Date();
  const diff = tzDiffMinutes(now, viewer, zone);
  const clock = formatInTimeZone(now, zone);
  const label = tzOffsetLabel(now, zone);
  // A null from any of these means the platform did not recognise the zone.
  // diff === 0 means two distinct zones share an offset (Europe/Berlin and
  // Europe/Paris) — nothing to tell the user either way. Bail before rendering
  // the Box, so neither case leaves an empty styled row behind.
  if (diff === null || diff === 0 || !clock || !label) return null;

  return (
    <Box sx={{ py: 0.5 }}>
      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{t("localTime")}</Typography>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 16 }}>{clock}</Typography>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {label} · {formatLead(t, diff)}
        </Typography>
      </Box>
    </Box>
  );
}
