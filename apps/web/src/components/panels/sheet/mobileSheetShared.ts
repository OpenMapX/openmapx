"use client";

import { createContext, type ReactNode, useContext, useEffect } from "react";

export const FloatingHandleContext = createContext<((floating: boolean) => void) | null>(null);

interface DetailChromeApi {
  setHeader: (node: ReactNode) => void;
  setFooter: (node: ReactNode) => void;
}

// Content rendered inside a mobile sheet can be several components deep (the
// sheet host -> a lazily-looked-up panel -> the actual detail card), so there
// is no prop path from that content back up to the sheet's pinned header /
// docked footer slots. This context gives it one. MobileBottomSheet provides
// it for every sheet it renders — place detail and list panels alike; desktop
// renders the same content inline via Paper and never mounts a sheet, so
// useDetailChrome is a no-op there.
//
// Exported so tests can provide a stub DetailChromeApi and observe what
// consumers register, without needing a full MobileBottomSheet host.
export const DetailChromeContext = createContext<DetailChromeApi | null>(null);

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
