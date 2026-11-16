"use client";

import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { formatDuration, formatMeasurementDistance } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";

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

/** The bar's end and search buttons: filled circles, large enough to hit while driving. */
const ROUND_BUTTON_SX = {
  width: 48,
  height: 48,
  // Over the app-wide rounded-square IconButton radius.
  borderRadius: "50%",
  bgcolor: "action.hover",
  color: "text.primary",
  "&:hover": { bgcolor: "action.selected" },
} as const;

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
  const locale = useLocale();
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
      {/* Equal-width side groups keep the summary centred whatever sits beside it. */}
      <Box sx={{ flex: "1 1 0", display: "flex" }}>
        <IconButton onClick={onEnd} aria-label={t("end")} sx={ROUND_BUTTON_SX}>
          <CloseIcon />
        </IconButton>
      </Box>
      <Box
        sx={{ flex: "0 1 auto", textAlign: "center", minWidth: 0 }}
        role="status"
        aria-live="polite"
      >
        <Typography sx={{ fontSize: 24, fontWeight: 600, lineHeight: 1.2 }}>
          {formatDuration(durationRemaining, locale)}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {secondaryLine}
        </Typography>
      </Box>
      <Box sx={{ flex: "1 1 0", display: "flex", justifyContent: "flex-end", gap: 1 }}>
        {onSearch && (
          <IconButton onClick={onSearch} aria-label={t("searchAlongRoute")} sx={ROUND_BUTTON_SX}>
            <SearchIcon />
          </IconButton>
        )}
        {menuToggle}
      </Box>
    </Box>
  );
}
