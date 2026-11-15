import { createTheme, type Shadows } from "@mui/material/styles";
import { THEME_COLORS, THEME_CORNER_RADIUS, type ThemeColors } from "@openmapx/core/theme";

/** The shared OpenMapX colours, which the installed app's native screens use too. */
function muiPalette(colors: ThemeColors) {
  return {
    primary: { main: colors.primary, contrastText: colors.onPrimary },
    secondary: { main: colors.secondary },
    background: { default: colors.background, paper: colors.surface },
    text: { primary: colors.text, secondary: colors.textSecondary },
    error: { main: colors.error },
  };
}

/**
 * Five soft, two-layer elevation levels (a tight key shadow under a wider
 * ambient one), spread over MUI's 25 elevation steps. They replace MUI's
 * default three-layer shadows, which read heavy and dated on floating map
 * chrome.
 */
function elevationShadows(): Shadows {
  const level = (keyY: number, keyBlur: number, y: number, blur: number, spread: number) =>
    `0 ${keyY}px ${keyBlur}px rgb(0 0 0 / 30%), 0 ${y}px ${blur}px ${spread}px rgb(0 0 0 / 15%)`;
  const levels = [
    level(1, 2, 1, 3, 1),
    level(1, 2, 2, 6, 2),
    level(1, 3, 4, 8, 3),
    level(2, 3, 6, 10, 4),
    level(4, 4, 8, 12, 6),
  ];
  // Steps 1–2 → level 1, 3–4 → 2, 5–8 → 3, 9–12 → 4, 13–24 → 5.
  const forStep = (step: number) =>
    levels[step <= 2 ? 0 : step <= 4 ? 1 : step <= 8 ? 2 : step <= 12 ? 3 : 4];
  return ["none", ...Array.from({ length: 24 }, (_, i) => forStep(i + 1))] as Shadows;
}

/** Reuse in visual previews so their typography, palette and overrides match production. */
export const appTheme = createTheme({
  cssVariables: {
    colorSchemeSelector: "class",
    disableCssColorScheme: true,
  },
  colorSchemes: {
    light: { palette: muiPalette(THEME_COLORS.light) },
    dark: { palette: muiPalette(THEME_COLORS.dark) },
  },
  defaultColorScheme: "light",
  typography: {
    fontFamily: '"Plus Jakarta Sans Variable", Arial, sans-serif',
    fontSize: 14,
    button: {
      textTransform: "none",
      fontWeight: 500,
    },
  },
  shape: {
    borderRadius: THEME_CORNER_RADIUS,
  },
  shadows: elevationShadows(),
  components: {
    MuiPaper: {
      defaultProps: { elevation: 0 },
      // Raised surfaces keep the palette's surface colour in dark mode; MUI's
      // elevation overlay would lift each one to its own lighter grey.
      styleOverrides: { root: { backgroundImage: "none" } },
    },
    MuiButton: {
      // Flat filled buttons; elevation belongs to floating surfaces, not actions.
      defaultProps: { disableElevation: true },
      styleOverrides: {
        // Pill-shaped buttons; fields and cards keep the shared corner radius.
        root: { borderRadius: 999 },
      },
      variants: [
        {
          // A secondary action on a light brand tint, quieter than `contained`
          // and more present than `text`.
          props: { variant: "tonal" },
          style: {
            paddingInline: 16,
            backgroundColor: "var(--omx-brand-light)",
            color: "var(--omx-brand)",
            "&:hover": {
              backgroundColor: "color-mix(in srgb, var(--omx-brand-light) 85%, var(--omx-brand))",
            },
          },
        },
      ],
    },
    MuiAccordion: {
      styleOverrides: {
        // MUI draws a top divider via an ::before pseudo-element intended for
        // flush-stacked accordions. Every accordion in this app is a spaced,
        // outlined/bordered card where it just floats as a stray line above
        // each one — disable it globally so panels don't need to fix it locally.
        root: {
          "&::before": { display: "none" },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: THEME_CORNER_RADIUS,
        },
      },
    },
    // The installed app draws the page under the status and navigation bars
    // (`viewport-fit=cover`), so every dialog and drawer keeps its content out
    // of them. In a plain browser tab the insets are 0.
    MuiDialog: {
      styleOverrides: {
        // A floating dialog is centred and sized within the safe area.
        container: ({ ownerState }) =>
          ownerState.fullScreen
            ? {}
            : {
                boxSizing: "border-box",
                paddingTop: "var(--omx-safe-top)",
                paddingBottom: "var(--omx-safe-bottom)",
                paddingLeft: "var(--omx-safe-left)",
                paddingRight: "var(--omx-safe-right)",
              },
        // A full-screen dialog still covers the bars, with its content inset.
        paperFullScreen: {
          boxSizing: "border-box",
          paddingTop: "var(--omx-safe-top)",
          paddingBottom: "var(--omx-safe-bottom)",
          paddingLeft: "var(--omx-safe-left)",
          paddingRight: "var(--omx-safe-right)",
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        // The screen edge the drawer is attached to and the two beside it;
        // its open side faces the page, not a system bar.
        paper: ({ ownerState }) => ({
          ...(ownerState.anchor !== "bottom" && { paddingTop: "var(--omx-safe-top)" }),
          ...(ownerState.anchor !== "top" && { paddingBottom: "var(--omx-safe-bottom)" }),
          ...(ownerState.anchor !== "right" && { paddingLeft: "var(--omx-safe-left)" }),
          ...(ownerState.anchor !== "left" && { paddingRight: "var(--omx-safe-right)" }),
        }),
      },
    },
  },
});

declare module "@mui/material/Button" {
  interface ButtonPropsVariantOverrides {
    tonal: true;
  }
}
