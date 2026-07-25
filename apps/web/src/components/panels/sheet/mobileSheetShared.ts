"use client";

import { createContext, useContext, useEffect } from "react";

export const FloatingHandleContext = createContext<((floating: boolean) => void) | null>(null);

/**
 * Opt the surrounding mobile bottom sheet into a floating handle layout —
 * the drag pill renders absolutely on top of the content (with a soft scrim
 * so it stays legible) instead of in its own band above the content.
 *
 * Use this in panels whose first child is a full-bleed visual (e.g. a place's
 * photo hero), so the photo can reach the rounded sheet corners. Pass `false`
 * (or stop rendering the panel) to revert to the default banded layout.
 *
 * No-op outside a mobile bottom sheet.
 */
export function useFloatingMobileSheetHandle(enabled: boolean) {
  const setFloating = useContext(FloatingHandleContext);
  useEffect(() => {
    if (!setFloating) return;
    setFloating(enabled);
    return () => setFloating(false);
  }, [enabled, setFloating]);
}
