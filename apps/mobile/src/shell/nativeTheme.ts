import { THEME_COLORS, THEME_CORNER_RADIUS, type ThemeColors } from "@openmapx/core/theme";
import { useColorScheme } from "react-native";

/**
 * Colours for the few native screens the shell draws itself.
 *
 * They come from the web UI's theme, so a native screen in front of the page
 * looks like part of the same product, and they follow the system appearance
 * like the splash screen and the web UI do by default. A white loading screen
 * on a dark phone flashes between a dark splash and a dark map, and leaves the
 * light status-bar icons unreadable.
 */
export interface NativePalette {
  scheme: "light" | "dark";
  background: string;
  title: string;
  body: string;
  accent: string;
  onAccent: string;
  /** The border of a secondary (outlined) button. */
  outline: string;
  /** The label of a secondary (outlined) button. */
  secondaryLabel: string;
}

/** `#RRGGBB` at the given opacity, as the web's outlined buttons draw their border. */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function paletteOf(scheme: "light" | "dark", colors: ThemeColors): NativePalette {
  return {
    scheme,
    // Full-screen pages, not raised sheets: light pages are white like the
    // web's full-screen dialogs, and dark ones match the splash and the web's
    // dark status bar.
    background: scheme === "light" ? colors.surface : colors.background,
    title: colors.text,
    body: colors.textSecondary,
    accent: colors.primary,
    onAccent: colors.onPrimary,
    outline: withAlpha(colors.primary, 0.5),
    secondaryLabel: colors.primary,
  };
}

export const LIGHT_PALETTE: NativePalette = paletteOf("light", THEME_COLORS.light);
export const DARK_PALETTE: NativePalette = paletteOf("dark", THEME_COLORS.dark);

/** Button shape and label weight, as the web's MUI theme draws them. */
export const BUTTON_SHAPE = {
  borderRadius: THEME_CORNER_RADIUS,
  labelWeight: "500",
} as const;

export function paletteFor(scheme: string | null | undefined): NativePalette {
  return scheme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

export function useNativePalette(): NativePalette {
  return paletteFor(useColorScheme());
}
