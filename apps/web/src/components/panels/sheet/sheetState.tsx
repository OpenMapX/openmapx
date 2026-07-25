"use client";

import {
  createContext,
  type RefCallback,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { type Detent, detentFromSnapIndex } from "./detents";

export interface SnapDetail {
  sheetState: "collapsed" | "partially-expanded" | "expanded";
  snapIndex: number;
}

export interface MobileSheetApi {
  detent: Detent;
  /** True once the content scroller has unlocked. */
  isExpanded: boolean;
  snapTo(detent: Detent, options?: { animate?: boolean }): void;
}

/**
 * Default for consumers rendered outside a mobile sheet — the desktop panels
 * render the same children in a plain Paper. Reporting a fully expanded sheet
 * means panels can use the hook without an isMobile branch.
 */
const DESKTOP_DEFAULT: MobileSheetApi = {
  detent: "full",
  isExpanded: true,
  snapTo: () => {},
};

export const MobileSheetContext = createContext<MobileSheetApi>(DESKTOP_DEFAULT);

export function useMobileSheet(): MobileSheetApi {
  return useContext(MobileSheetContext);
}

export function detentFromSnapEvent(detail: SnapDetail): { detent: Detent; isExpanded: boolean } {
  return {
    detent: detentFromSnapIndex(detail.snapIndex),
    isExpanded: detail.sheetState === "expanded",
  };
}

/**
 * Reports whether the observed element has scrolled out of the sheet's
 * scroller — drives the header morph and the docked action bar without reading
 * scroll offsets every frame.
 */
export function useSheetSentinel(): { ref: RefCallback<HTMLElement>; passed: boolean } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [passed, setPassed] = useState(false);

  useEffect(() => {
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setPassed(!entry.isIntersecting), {
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);

  return { ref: useCallback((node: HTMLElement | null) => setEl(node), []), passed };
}
