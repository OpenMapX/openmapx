import type { SxProps, Theme } from "@mui/material/styles";
import { BRAND } from "@/integration-api/runtime/theme";
import { SEARCH_BAR_HEIGHT, SEARCH_BAR_INSET, topInset } from "@/lib/layout";

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
/** Height of a floating chip on wider screens; controls placed beside chips match it. */
export const FLOATING_CHIP_HEIGHT = 32;
/** A phone's chips are taller, for the touch target. */
const PHONE_CHIP_HEIGHT = 36;

export function floatingChipSx(active: boolean, variant: "category" | "toggle"): SxProps<Theme> {
  const base = {
    height: { xs: PHONE_CHIP_HEIGHT, sm: FLOATING_CHIP_HEIGHT },
    borderRadius: 999,
    fontWeight: 500,
    fontSize: 14,
    bgcolor: active ? BRAND : "background.paper",
    color: active ? "#fff" : "text.primary",
    borderColor: active ? BRAND : "var(--omx-chip-border)",
    boxShadow: 1,
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
 * Where the floating chip row ends, measured from the search bar's top: below
 * the bar on a phone, beside it on desktop. Chrome stacked under the chips
 * starts from here.
 */
export const CHIP_ROW_END = {
  xs: SEARCH_BAR_HEIGHT + 8 + PHONE_CHIP_HEIGHT,
  sm: (SEARCH_BAR_HEIGHT + FLOATING_CHIP_HEIGHT) / 2,
} as const;

/** Vertical padding of a floating toolbar row, enough for its chips' shadows. */
const TOOLBAR_PADDING_Y = 4;

/**
 * Shared positioning core for the floating toolbar rows that sit over the map
 * (top-anchored, offset for the desktop sidebar). Spread into the row's `sx`
 * and add per-row extras (gap, flexWrap, pointerEvents, mask, etc.).
 */
export const floatingToolbarSx = {
  position: "absolute",
  top: {
    // 8px below the search bar on a phone; level with its centre beside it.
    // The row's vertical padding leaves room for the chips' shadows.
    xs: topInset(SEARCH_BAR_INSET, SEARCH_BAR_HEIGHT + 8 - TOOLBAR_PADDING_Y),
    sm: topInset(
      SEARCH_BAR_INSET,
      (SEARCH_BAR_HEIGHT - FLOATING_CHIP_HEIGHT) / 2 - TOOLBAR_PADDING_Y,
    ),
  },
  left: { xs: "var(--omx-safe-left)", sm: "calc(420px + var(--omx-safe-left))" },
  right: { xs: "var(--omx-safe-right)", sm: "calc(108px + var(--omx-safe-right))" },
  zIndex: 10,
  display: "flex",
  alignItems: "center",
  px: { xs: 1, sm: 0 },
  py: `${TOOLBAR_PADDING_Y}px`,
} as const;
