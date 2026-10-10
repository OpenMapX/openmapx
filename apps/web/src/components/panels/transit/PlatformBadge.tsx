"use client";

import Box from "@mui/material/Box";
import { useTranslations } from "next-intl";

/**
 * Small platform/track pill ("Pl. 3"), reused across the transit nav banner,
 * transfer guidance, and the live stop list. When `changed` is set it takes an
 * attention colour to flag a realtime platform change.
 *
 * `tone` picks the palette so the pill stays legible both on the brand-coloured banner
 * ("onBanner") and on the light sheet surface ("surface").
 */
export function PlatformBadge({
  code,
  changed = false,
  scheduledCode,
  tone = "surface",
}: {
  code: string;
  changed?: boolean;
  scheduledCode?: string;
  tone?: "surface" | "onBanner";
}) {
  const t = useTranslations("transit");
  const wasChanged = changed || (!!scheduledCode && scheduledCode !== code);
  const surface = wasChanged
    ? { bgcolor: "warning.main", color: "warning.contrastText" }
    : { bgcolor: "action.selected", color: "text.primary" };
  const onBanner = wasChanged
    ? { bgcolor: "warning.main", color: "warning.contrastText" }
    : { bgcolor: "rgba(255, 255, 255, 0.22)", color: "inherit" };
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
        px: 0.75,
        py: 0.125,
        borderRadius: 1,
        fontSize: "0.75rem",
        fontWeight: 700,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
        ...(tone === "onBanner" ? onBanner : surface),
      }}
    >
      {t("platform")}{" "}
      {wasChanged && scheduledCode && scheduledCode !== code ? `${scheduledCode} → ${code}` : code}
      {wasChanged && ` (${t("platformChanged")})`}
    </Box>
  );
}
