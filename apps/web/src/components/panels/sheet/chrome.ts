import type { Theme } from "@mui/material/styles";

/**
 * Custom properties handed to the sheet host. The chrome lives in a shadow
 * root, so theme values reach it through properties and ::part rules rather
 * than through Emotion. Slotted content stays in the light DOM and is styled
 * normally.
 *
 * `keyboardInset` shrinks `--sheet-max-height` by the same amount the host is
 * lifted inline, so the sheet's top edge never runs off the top of the
 * shrunken viewport while the keyboard is up.
 *
 * The library independently computes its own
 * `--sheet-safe-max-height: calc(var(--sheet-max-height) - env(keyboard-inset-height,
 * var(--sw-keyboard-height, 0px)))`, setting `--sw-keyboard-height` itself from
 * `visualViewport.offsetTop`. On every browser this has been tested against,
 * `env(keyboard-inset-height)` and the library's own inset both resolve to 0,
 * so this shrink and the library's are inert together — but they measure the
 * same thing. Do not add a third keyboard-height compensation here or in
 * MobileBottomSheet; if a browser ever makes the library's mechanism resolve
 * non-zero, this one needs to come out rather than gain a sibling.
 */
export function sheetChromeVars(
  theme: Theme,
  maxHeight: string,
  keyboardInset = 0,
): Record<string, string> {
  const dark = theme.palette.mode === "dark";
  return {
    "--sheet-max-height": keyboardInset > 0 ? `calc(${maxHeight} - ${keyboardInset}px)` : maxHeight,
    // MD3 bottom sheet: 28dp top corners (library default is 12px).
    "--sheet-border-radius": "28px",
    // Dark mode sits on background.default so sticky children pinned to that
    // surface stay flush, matching the desktop panels.
    "--sheet-background": dark ? theme.palette.background.default : theme.palette.background.paper,
  };
}

/**
 * Part styling for the shadow chrome. `content` ships an 8px side padding that
 * would gutter every panel, the handle is 40x5 where MD3 specifies 32x4, and
 * the home-indicator inset has to be re-applied because the host is anchored
 * to the very bottom of the viewport.
 */
export function SHEET_PART_STYLES(theme: Theme) {
  return {
    "&::part(content)": { padding: 0, paddingBottom: "var(--omx-safe-bottom)" },
    "&::part(footer)": { paddingBottom: "var(--omx-safe-bottom)" },
    "&::part(handle)": { width: 32, height: 4 },
    // Separates the sheet from the map behind it, matching the elevation the
    // `Paper elevation={6}` this component replaced used to provide.
    "&::part(sheet)": { boxShadow: theme.shadows[6] },
    // In nested-scroll + expand-to-scroll mode the shadow CSS sets both
    // `.sheet` and `.sheet-wrapper` to `position: static`, so an absolutely
    // positioned header would otherwise resolve against the fixed, scrolling
    // host itself and land far off screen. Make the sheet part the positioning
    // context.
    "&[floating-handle]::part(sheet)": { position: "relative" },
    // Full-bleed hero photos need the pill to float over the content rather than
    // occupy a band above it.
    "&[floating-handle]::part(header)": {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      background: "transparent",
      zIndex: 1,
    },
  } as const;
}
