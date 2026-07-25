"use client";

import Box from "@mui/material/Box";
import type { SxProps, Theme } from "@mui/material/styles";
import { useTranslations } from "next-intl";
import { useState } from "react";

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
  /** Pre-rendered, sanitized credit HTML — one entry per source. */
  html: string[];
  /**
   * Show a "©" toggle instead of the full strip, expanding on tap. For maps too
   * small to give up a strip's worth of pixels (the ~130–200px minimaps), where
   * an always-on strip would cover most of the view.
   */
  compact?: boolean;
  sx?: SxProps<Theme>;
}

/**
 * Credits overlay for an embedded map (minimaps, the offline area picker and
 * viewer). Pins itself to the bottom-right of the nearest positioned ancestor,
 * so the host only needs `position: relative` on its map wrapper.
 *
 * Replaces MapLibre's built-in AttributionControl on those maps: it renders
 * inline like the main map's footer instead of behind MapLibre's ⓘ toggle, and
 * needs none of the CSS overrides the built-in control required.
 */
export function MapCredits({ html, compact = false, sx }: MapCreditsProps) {
  const t = useTranslations("footer");
  const [expanded, setExpanded] = useState(false);
  if (html.length === 0) return null;

  const anchored = {
    position: "absolute",
    right: 0,
    bottom: 0,
    maxWidth: "100%",
    zIndex: 1,
  } as const;

  // Neither the toggle nor the strip may reach the host map's own click handler:
  // the minimaps navigate when clicked, and reading the credits shouldn't.
  const swallowClick = (event: React.MouseEvent) => event.stopPropagation();

  const strip = (
    <Box
      data-testid="map-credits"
      sx={{ ...CREDITS_SX, maxWidth: "100%", textAlign: "right" }}
      // Entries are sanitized where they're built (`lib/map.ts` credit HTML and
      // `useMapAttributions`), anchors with safe hrefs only.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: credits carry license-required publisher links
      dangerouslySetInnerHTML={{ __html: html.join(CREDITS_SEPARATOR) }}
    />
  );

  if (!compact) {
    return (
      <Box onClick={swallowClick} sx={{ ...anchored, ...sx }}>
        {strip}
      </Box>
    );
  }

  // Column so the toggle keeps its corner and the credits stack above it —
  // expanding must never cover the control that collapses them again.
  return (
    <Box
      onClick={swallowClick}
      sx={{
        ...anchored,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        ...sx,
      }}
    >
      {expanded && strip}
      <Box
        component="button"
        type="button"
        aria-label={t("credits")}
        aria-expanded={expanded}
        title={t("credits")}
        onClick={() => setExpanded((open) => !open)}
        sx={{ ...CREDITS_SX, border: 0, cursor: "pointer", minWidth: "15px" }}
      >
        ©
      </Box>
    </Box>
  );
}
