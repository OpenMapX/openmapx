"use client";

import Box from "@mui/material/Box";
import { refKind } from "@openmapx/core";
import { type SignColors, signPalette } from "./signPalette";

interface Props {
  roadRef: string;
  /** ISO 3166-1 alpha-2 country of the route origin; null falls back to the EU palette. */
  country?: string | null;
  size?: "banner" | "compact";
}

/** Colours for one ref kind on the country's palette. */
function colorsFor(palette: ReturnType<typeof signPalette>, roadRef: string): SignColors {
  switch (refKind(roadRef)) {
    case "federal":
      return palette.primary;
    case "european":
      return palette.european;
    default:
      return palette.motorway;
  }
}

const FONT_SIZE = { banner: 13, compact: 11 } as const;

/** One route-ref shield (a rounded rectangle in the real-sign colours). */
export function RouteShield({ roadRef, country, size = "banner" }: Props) {
  const colors = colorsFor(signPalette(country ?? null), roadRef);
  return (
    <Box
      component="span"
      role="img"
      aria-label={roadRef}
      data-bg={colors.bg}
      sx={{
        display: "inline-block",
        borderRadius: 1,
        px: 0.75,
        py: 0.25,
        bgcolor: colors.bg,
        color: colors.fg,
        fontWeight: 700,
        fontSize: FONT_SIZE[size],
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {roadRef}
    </Box>
  );
}
