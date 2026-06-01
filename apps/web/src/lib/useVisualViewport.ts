"use client";

import { useEffect, useState } from "react";

export interface VisualViewportState {
  /**
   * Pixels the on-screen keyboard (or another UA overlay) currently covers at
   * the bottom of the layout viewport — 0 when no keyboard is open or the
   * `visualViewport` API is unavailable.
   */
  keyboardInset: number;
}

function computeKeyboardInset(): number {
  if (typeof window === "undefined" || !window.visualViewport) return 0;
  const vv = window.visualViewport;
  // The layout viewport (window.innerHeight) doesn't shrink for the keyboard,
  // but the visual viewport does — the difference (minus any top offset from a
  // pinch-zoom) approximates the keyboard's height.
  return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
}

/**
 * Tracks the on-screen keyboard inset via the Visual Viewport API so layout
 * (e.g. the mobile bottom sheet) can lift content above the keyboard. Returns
 * `keyboardInset: 0` where unsupported, so callers degrade cleanly.
 */
export function useVisualViewport(): VisualViewportState {
  const [keyboardInset, setKeyboardInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    const onChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setKeyboardInset(computeKeyboardInset()));
    };
    onChange();
    vv.addEventListener("resize", onChange);
    vv.addEventListener("scroll", onChange);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, []);

  return { keyboardInset };
}
