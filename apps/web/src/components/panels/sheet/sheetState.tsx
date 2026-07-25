"use client";

import {
  createContext,
  type MouseEvent,
  type RefCallback,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { type Detent, type DetentConfig, detentFromSnapIndex } from "./detents";

export interface SnapDetail {
  sheetState: "collapsed" | "partially-expanded" | "expanded";
  snapIndex: number;
}

export interface MobileSheetApi {
  detent: Detent;
  /** True once the content scroller has unlocked. */
  isExpanded: boolean;
  /**
   * Whether the consumer is actually inside a sheet. `detent` cannot answer
   * this: a fully expanded sheet and the desktop panel both report "full", so
   * a layout that should differ between the two has to key off this instead.
   */
  inSheet: boolean;
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
  inSheet: false,
  snapTo: () => {},
};

export const MobileSheetContext = createContext<MobileSheetApi>(DESKTOP_DEFAULT);

export function useMobileSheet(): MobileSheetApi {
  return useContext(MobileSheetContext);
}

/** Controls that own their own tap, so a background-tap handler must not act on them. */
const INTERACTIVE =
  'button, a, input, select, textarea, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"]';

/**
 * Expands a collapsed sheet when the user taps its background.
 *
 * Returns an onClick for a panel's outermost element. It deliberately ignores
 * taps that started on a control: those already do something, and letting the
 * expand run as the event bubbles would undo whatever the control just did —
 * selecting a route collapses the sheet, and an unguarded handler would
 * immediately re-expand it.
 */
export function useExpandOnBackgroundTap(): (event: MouseEvent<HTMLElement>) => void {
  const { detent, snapTo } = useMobileSheet();
  return useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (detent !== "peek") return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
      snapTo("mid");
    },
    [detent, snapTo],
  );
}

export function detentFromSnapEvent(
  detail: SnapDetail,
  config: DetentConfig,
): { detent: Detent; isExpanded: boolean } {
  return {
    detent: detentFromSnapIndex(detail.snapIndex, config),
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
