"use client";

import { useLayoutEffect, useState } from "react";

interface LayoutElements {
  shell: HTMLElement | null;
  banner: HTMLElement | null;
  junction: HTMLElement | null;
  bottom: HTMLElement | null;
  speedLimit: HTMLElement | null;
  bottomHeader: HTMLElement | null;
  isMobile: boolean;
  sheetClearance: number;
  /** The speed badge rides the sheet by translation, so its margins exclude the clearance. */
  speedLimitRidesSheet: boolean;
  sheetOccupiedHeight: number;
  mobilePanelPending: boolean;
}

function verticalMargins(element: HTMLElement | null): number {
  if (!element) return 0;
  const style = getComputedStyle(element);
  return (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0);
}

/** Real layout budget, independent of an overflowing photo pushing/shrinking bottom controls. */
export function useJunctionPreviewBudget({
  shell,
  banner,
  junction,
  bottom,
  speedLimit,
  bottomHeader,
  isMobile,
  sheetClearance,
  speedLimitRidesSheet,
  sheetOccupiedHeight,
  mobilePanelPending,
}: LayoutElements): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!shell || !banner || !junction || !bottom || mobilePanelPending) {
      setHeight(null);
      return;
    }
    const update = () => {
      const shellRect = shell.getBoundingClientRect();
      const junctionRect = junction.getBoundingClientRect();
      if (shellRect.height <= 0 || junctionRect.width <= 0) {
        setHeight(null);
        return;
      }
      const speedHeight =
        (speedLimit?.getBoundingClientRect().height ?? 0) +
        verticalMargins(speedLimit) +
        (speedLimitRidesSheet ? sheetClearance : 0);
      const headerHeight = bottomHeader?.getBoundingClientRect().height ?? 0;
      // The speed badge's height now includes sheet clearance, from its mobile
      // margin or, while it rides the sheet, added above.
      // Desktop headers never shrink, even if their containing panel does.
      const minimumControls = isMobile
        ? Math.max(speedHeight, sheetClearance, sheetOccupiedHeight, headerHeight)
        : speedHeight + headerHeight + verticalMargins(bottomHeader?.parentElement ?? null);
      const controlsTop = Math.min(
        bottom.getBoundingClientRect().top,
        shellRect.bottom - minimumControls,
      );
      const followingContent = Math.max(
        0,
        banner.getBoundingClientRect().bottom - junctionRect.bottom,
      );
      setHeight(Math.max(0, controlsTop - junctionRect.top - followingContent));
    };
    update();
    const observer = new ResizeObserver(update);
    for (const element of [
      shell,
      banner,
      junction,
      bottom,
      speedLimit,
      bottomHeader,
      bottomHeader?.parentElement,
    ]) {
      if (element) observer.observe(element);
    }
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [
    shell,
    banner,
    junction,
    bottom,
    speedLimit,
    bottomHeader,
    isMobile,
    sheetClearance,
    speedLimitRidesSheet,
    sheetOccupiedHeight,
    mobilePanelPending,
  ]);
  return height;
}
