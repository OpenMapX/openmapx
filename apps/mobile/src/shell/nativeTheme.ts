import { useColorScheme } from "react-native";

/**
 * Colours for the few native screens the shell draws itself.
 *
 * They follow the system appearance, like the splash screen and the web UI do
 * by default. A white loading screen on a dark phone flashes between a dark
 * splash and a dark map, and leaves the light status-bar icons unreadable.
 */
export interface NativePalette {
  scheme: "light" | "dark";
  background: string;
  title: string;
  body: string;
  accent: string;
  onAccent: string;
  outline: string;
  secondaryLabel: string;
}

export const LIGHT_PALETTE: NativePalette = {
  scheme: "light",
  background: "#FFFFFF",
  title: "#101418",
  body: "#3C4650",
  accent: "#1B69D6",
  onAccent: "#FFFFFF",
  outline: "#C3CBD3",
  secondaryLabel: "#1B3A5C",
};

/** Matches the splash screen's dark background. */
export const DARK_PALETTE: NativePalette = {
  scheme: "dark",
  background: "#0B0F14",
  title: "#E8ECF0",
  body: "#B4BEC8",
  accent: "#5B9BF0",
  onAccent: "#0B0F14",
  outline: "#3C4650",
  secondaryLabel: "#B9D3F5",
};

export function paletteFor(scheme: string | null | undefined): NativePalette {
  return scheme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

export function useNativePalette(): NativePalette {
  return paletteFor(useColorScheme());
}
