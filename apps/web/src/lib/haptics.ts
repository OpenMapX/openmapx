"use client";

/**
 * Subtle haptic feedback for deliberate touch interactions (sheet snaps,
 * successful saves, download completion). Uses the Vibration API, which only
 * does anything on Android Chrome — iOS Safari and desktop ignore it, so every
 * call is a safe no-op there. Gated on a user setting and `prefers-reduced-motion`.
 */

const STORAGE_KEY = "openmapx-haptics-enabled";

/** Default on; only an explicit opt-out is stored. */
export function isHapticsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(STORAGE_KEY) !== "false";
}

export function setHapticsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  if (enabled) window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, "false");
}

/** Whether the device can actually vibrate (Android Chrome). */
export function hapticsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function vibrate(pattern: number | number[]): void {
  if (!hapticsSupported() || !isHapticsEnabled() || prefersReducedMotion()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // ignore — vibration is purely decorative
  }
}

export const haptics = {
  /** A light tick for a committed gesture (e.g. a sheet snap). */
  tap: () => vibrate(8),
  /** A short double-pulse confirming an action succeeded. */
  success: () => vibrate([10, 30, 10]),
  /** A heavier pulse for a warning / failure. */
  warn: () => vibrate([20, 50, 20]),
};
