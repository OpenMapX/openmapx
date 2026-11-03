import { Platform, StatusBar } from "react-native";

/**
 * Keeping native screens clear of the system bars.
 *
 * The app draws edge to edge. A scrolling native screen gets the safe area from
 * the scroll view on iOS; on Android the status bar's height is padded in.
 */
export const SCROLL_SAFE_AREA = {
  contentInsetAdjustmentBehavior: "automatic",
} as const;

export function topBarInset(): number {
  return Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
}
