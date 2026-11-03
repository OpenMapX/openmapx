/**
 * The OpenMapX colour scheme, shared by the web UI and the installed app's
 * native screens so both draw the same product.
 *
 * Plain data with no runtime imports: the web feeds it to its MUI theme, and
 * the mobile shell, which has no MUI, derives its few native screens from it.
 */

export interface ThemeColors {
  primary: string;
  /** Text and icons drawn on `primary`. */
  onPrimary: string;
  secondary: string;
  /** The page behind everything. */
  background: string;
  /** Sheets, dialogs and other raised surfaces. */
  surface: string;
  text: string;
  textSecondary: string;
  error: string;
}

export const THEME_COLORS: Record<"light" | "dark", ThemeColors> = {
  light: {
    primary: "#207E23",
    onPrimary: "#ffffff",
    secondary: "#34A853",
    background: "#f5f5f5",
    surface: "#ffffff",
    text: "#202124",
    textSecondary: "#5f6368",
    error: "#d32f2f",
  },
  dark: {
    primary: "#71D674",
    onPrimary: "#000000",
    secondary: "#81C995",
    background: "#1C1C1C",
    surface: "#2D2D2D",
    text: "#E8EAED",
    textSecondary: "#9AA0A6",
    error: "#F28B82",
  },
};

/** Corner radius of buttons, cards and fields, in CSS pixels. */
export const THEME_CORNER_RADIUS = 8;

/**
 * The browser and system chrome colour (Android's status bar, an installed
 * web app's title bar) for each colour scheme.
 */
export const THEME_CHROME_COLOR = {
  light: THEME_COLORS.light.primary,
  dark: THEME_COLORS.dark.background,
} as const;
