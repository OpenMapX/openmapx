"use client";

import PublicOutlinedIcon from "@mui/icons-material/PublicOutlined";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { timeZoneAt, tzDiffMinutes, tzOffsetLabel, viewerTimeZone } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { BRAND } from "@/integration-api/runtime/theme";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";

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
  const fmt = useDateTimeFormat();
  // Memoize the lookup the same way PlaceHeaderWeather does, so it isn't
  // recomputed on every render.
  const zone = useMemo(() => timeZoneAt(lat, lng), [lat, lng]);

  const viewer = viewerTimeZone();
  if (!zone || zone === viewer) return null;

  const now = new Date();
  const diff = tzDiffMinutes(now, viewer, zone);
  const label = tzOffsetLabel(now, zone);
  // A null from either of these means the platform did not recognise the
  // zone. diff === 0 means two distinct zones share an offset (Europe/Berlin
  // and Europe/Paris) — nothing to tell the user either way. Bail before
  // rendering the Box, so neither case leaves an empty styled row behind.
  //
  // Order matters: resolve the label first. `fmt.time` (unlike the helpers
  // above) throws rather than returning null for a zone id the platform
  // doesn't recognise, so the label doubles as the validity gate that keeps
  // the call below safe.
  if (diff === null || diff === 0 || !label) return null;
  const clock = fmt.time(now, { timeZone: zone });

  return (
    // Laid out like the overview's other detail rows, beside which it sits as a location fact.
    <Box sx={{ display: "flex", gap: 2, alignItems: "center", py: 1.25 }}>
      <Box sx={{ color: BRAND, flexShrink: 0, display: "flex" }}>
        <PublicOutlinedIcon sx={{ fontSize: 22 }} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2">{t("localTimeAt", { time: clock })}</Typography>
        <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
          {label} · {formatLead(t, diff)}
        </Typography>
      </Box>
    </Box>
  );
}
