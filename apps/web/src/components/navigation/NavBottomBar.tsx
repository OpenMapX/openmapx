"use client";

import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { formatDuration, formatMeasurementDistance } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";

interface Props {
  durationRemaining: number;
  etaEpochMs: number;
  onEnd: () => void;
  /** Distance remaining; omit for transit, which has no single trip distance. */
  distanceRemaining?: number;
  units?: "metric" | "imperial";
  /** Search-along-route action; omit to hide the search button (transit has none). */
  onSearch?: () => void;
  /**
   * Trailing control for revealing the nav menu (a chevron on desktop). On
   * mobile the menu is reached by dragging the sheet, so this is omitted.
   */
  menuToggle?: ReactNode;
  /**
   * Overrides the default secondary line ("{distance} · {time}"). Transit passes
   * its own "Arrive {time}" here since it shows no distance.
   */
  secondary?: ReactNode;
}

export function NavBottomBar({
  durationRemaining,
  etaEpochMs,
  onEnd,
  distanceRemaining,
  units = "metric",
  onSearch,
  menuToggle,
  secondary,
}: Props) {
  const t = useTranslations("navigation");
  const fmt = useDateTimeFormat();
  // Just the arrival time — no "ETA"/"Ankunft" label, to keep the bar terse.
  const etaTime = fmt.time(etaEpochMs);
  const secondaryLine =
    secondary ??
    (distanceRemaining != null
      ? `${formatMeasurementDistance(distanceRemaining, units)} · ${etaTime}`
      : etaTime);

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.5 }}>
      <IconButton
        onClick={onEnd}
        aria-label={t("end")}
        // borderRadius: the app-wide MuiIconButton override (providers.tsx) sets
        // a rounded-square radius; force a full circle so the visible border is
        // round rather than a rounded square.
        sx={{
          border: "1px solid",
          borderColor: "divider",
          color: "text.primary",
          borderRadius: "50%",
        }}
      >
        <CloseIcon />
      </IconButton>
      <Box sx={{ flexGrow: 1, textAlign: "center", minWidth: 0 }} role="status" aria-live="polite">
        <Typography variant="h6" sx={{ fontWeight: 700, lineHeight: 1.15 }}>
          {formatDuration(durationRemaining)}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {secondaryLine}
        </Typography>
      </Box>
      {onSearch && (
        <IconButton
          onClick={onSearch}
          aria-label={t("searchAlongRoute")}
          // Round with a border, matching the end button on the left.
          sx={{
            border: "1px solid",
            borderColor: "divider",
            color: "text.primary",
            borderRadius: "50%",
          }}
        >
          <SearchIcon />
        </IconButton>
      )}
      {menuToggle}
    </Box>
  );
}
