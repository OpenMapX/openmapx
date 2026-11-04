import { createTheme } from "@mui/material/styles";
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
  components: {
    MuiPaper: {
      defaultProps: { elevation: 0 },
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
