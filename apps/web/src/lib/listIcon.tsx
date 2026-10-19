import SvgIcon from "@mui/material/SvgIcon";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

const ICON_PATHS: Record<string, string> = {
  heart:
    "m12 21.35-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z",
  flag: "M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z",
  star: "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
  bookmark: "M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2m0 15-5-2.18L7 18V5h10z",
};

export function listMarkerIcon(icon: string | null): { path: string } | { emoji: string } {
  if (icon && Array.from(icon).some((character) => character.charCodeAt(0) > 127))
    return { emoji: icon };
  return { path: (icon && ICON_PATHS[icon]) || ICON_PATHS.bookmark };
}

export function resolveListIcon(icon: string | null, size = 22): ReactNode {
  const glyph = listMarkerIcon(icon);
  if ("emoji" in glyph) {
    return (
      <Typography component="span" sx={{ fontSize: size - 2, lineHeight: 1 }}>
        {glyph.emoji}
      </Typography>
    );
  }
  return (
    <SvgIcon sx={{ color: BRAND, fontSize: size }}>
      <path d={glyph.path} />
    </SvgIcon>
  );
}
