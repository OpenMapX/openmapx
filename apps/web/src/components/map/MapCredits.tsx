"use client";

import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";
import {
  buildAttributionPresentation,
  projectAttributionPresentations,
} from "@openmapx/core/attribution";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useTranslations } from "next-intl";
import { AttributionDetails } from "@/components/ui/AttributionDetails";
import { AttributionNotices } from "@/components/ui/AttributionNotices";

/**
 * Shared look of every credits strip in the app: 10px/13px, near-black on an
 * opaque bar — at this size, map imagery showing through the bar makes it
 * unreadable. Consumed by `<MapCredits>` for embedded maps and by
 * `<MapFooter>` for the main map, so the two can't drift apart.
 */
export const CREDITS_SX = {
  fontSize: "10px",
  lineHeight: "13px",
  color: "var(--omx-footer-text)",
  bgcolor: "var(--omx-footer-bg)",
  px: "5px",
  py: "2px",
  "& a": {
    color: "inherit",
    textDecoration: "none",
    font: "inherit",
    "&:hover": { textDecoration: "underline" },
  },
} as const;

/** Separator between individual credits, matching MapLibre's own strip. */
export const CREDITS_SEPARATOR = " | ";

interface MapCreditsProps {
  attributions: readonly Attribution[];
  sx?: SxProps<Theme>;
}

/** Shared permanent map notices and complete one-action details, including minimaps. */
export function MapCredits({ attributions, sx }: MapCreditsProps) {
  const t = useTranslations("footer");
  const presentation = projectAttributionPresentations(
    attributions.map((attr) => buildAttributionPresentation(attr, "map")),
  );
  if (presentation.fullHtml.length === 0) return null;
  return (
    <Box
      onClick={(event) => event.stopPropagation()}
      sx={{ position: "absolute", right: 0, bottom: 0, maxWidth: "100%", zIndex: 1, ...sx }}
    >
      <Box
        data-testid="map-credits"
        sx={{ ...CREDITS_SX, textAlign: "right", overflowWrap: "anywhere" }}
      >
        <AttributionNotices notices={presentation.visible} />
        {presentation.visible.length > 0 && " | "}
        <AttributionDetails
          entries={presentation.details}
          label={t("credits")}
          logos={presentation.visible.flatMap((notice) => notice.logos)}
        />
      </Box>
    </Box>
  );
}
