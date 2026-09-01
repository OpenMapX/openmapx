import type { SxProps, Theme } from "@mui/material/styles";
import { BRAND } from "@/integration-api/runtime/theme";

/**
 * Shared "floating pill chip" styling used by the map-overlay chip rows
 * (category chips, the category filter bar toggles, the opening-times chip).
 *
 * Two variants exist because the rows diverge in a few precise ways:
 *  - `category` (CategoryChips): scrollable row, so chips get `flexShrink: 0`.
 *  - `toggle` (CategoryFilterBar): the row wrapper has `pointerEvents: "none"`
 *    so each chip re-enables `pointerEvents: "auto"` and adds label
 *    right-padding.
 *
 * The shared core (sizing, colors, icon styling, hover) is identical — both
 * use the theme-aware `--omx-chip-hover` so the inactive hover stays dark in
 * dark mode.
 */
export function floatingChipSx(active: boolean, variant: "category" | "toggle"): SxProps<Theme> {
  const base = {
    height: 36,
    borderRadius: "18px",
    fontWeight: 500,
    fontSize: 13,
    bgcolor: active ? BRAND : "background.paper",
    color: active ? "#fff" : "text.primary",
    borderColor: active ? BRAND : "var(--omx-border)",
    boxShadow: active ? "none" : "0 1px 3px var(--omx-shadow-soft)",
    cursor: "pointer",
    userSelect: "none",
    "& .MuiChip-icon": { color: "inherit", ml: "10px", mr: "-4px" },
  } as const;

  if (variant === "category") {
    return {
      ...base,
      flexShrink: 0,
      "&&:hover": {
        bgcolor: active ? "var(--omx-brand-hover)" : "var(--omx-chip-hover)",
      },
    };
  }

  return {
    ...base,
    pointerEvents: "auto",
    "& .MuiChip-label": { pr: "10px" },
    "&&:hover": { bgcolor: active ? "var(--omx-brand-hover)" : "var(--omx-chip-hover)" },
  };
}

/**
 * Shared positioning core for the floating toolbar rows that sit over the map
 * (top-anchored, offset for the desktop sidebar). Spread into the row's `sx`
 * and add per-row extras (gap, flexWrap, pointerEvents, mask, etc.).
 */
export const floatingToolbarSx = {
  position: "absolute",
  top: {
    xs: "calc(72px + var(--omx-safe-top))",
    sm: "calc(18px + var(--omx-safe-top))",
  },
  left: { xs: "var(--omx-safe-left)", sm: "calc(420px + var(--omx-safe-left))" },
  right: { xs: "var(--omx-safe-right)", sm: "calc(108px + var(--omx-safe-right))" },
  zIndex: 10,
  display: "flex",
  alignItems: "center",
  px: { xs: 1, sm: 0 },
  py: "2px",
} as const;
