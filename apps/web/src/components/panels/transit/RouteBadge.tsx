"use client";

import Chip from "@mui/material/Chip";
import { MODE_COLORS } from "@openmapx/core";
import type { TransportMode } from "@openmapx/mobility-core/transit";

function expandHex(hex: string): string {
  // Expand 3-digit hex (#abc) to 6-digit (#aabbcc)
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
  return hex.startsWith("#") ? hex : `#${hex}`;
}

function contrastText(hex: string): string {
  const full = expandHex(hex);
  const r = Number.parseInt(full.slice(1, 3), 16);
  const g = Number.parseInt(full.slice(3, 5), 16);
  const b = Number.parseInt(full.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return "#000";
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000" : "#fff";
}

interface RouteBadgeProps {
  shortName: string;
  color?: string;
  textColor?: string;
  mode: TransportMode;
  size?: "small" | "medium";
  onClick?: () => void;
}

export function RouteBadge({
  shortName,
  color,
  textColor,
  mode,
  size = "small",
  onClick,
}: RouteBadgeProps) {
  const bg = color && color !== "" ? `#${color.replace("#", "")}` : MODE_COLORS[mode];
  const fg = textColor && textColor !== "" ? `#${textColor.replace("#", "")}` : contrastText(bg);

  return (
    <Chip
      label={shortName}
      size={size}
      onClick={onClick}
      sx={{
        bgcolor: bg,
        color: fg,
        fontWeight: 700,
        fontSize: size === "small" ? "0.75rem" : "0.85rem",
        height: size === "small" ? 24 : 28,
        borderRadius: "4px",
        cursor: onClick ? "pointer" : "default",
        "&:hover": onClick ? { opacity: 0.85 } : {},
      }}
    />
  );
}
