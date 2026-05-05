"use client";

import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useEffect, useSyncExternalStore } from "react";

const heights = new Map<string, number>();
const listeners = new Set<() => void>();
let cachedMax = 0;

function recomputeMax() {
  let max = 0;
  for (const v of heights.values()) {
    if (v > max) max = v;
  }
  cachedMax = max;
}

function emit() {
  recomputeMax();
  for (const listener of listeners) listener();
}

function setHeight(id: string, height: number | null) {
  if (height == null || height <= 0) {
    if (!heights.delete(id)) return;
  } else {
    if (heights.get(id) === height) return;
    heights.set(id, height);
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => cachedMax;
const getServerSnapshot = () => 0;

/** Max rendered height (px) of the bottom-anchored mobile panels. */
export function useMobilePanelMaxHeight(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Tracks the rendered height of a bottom-anchored mobile panel so other UI
 * (like the right-side map controls) can sit just above its top edge.
 *
 * Element is passed via state-backed callback ref so attach/detach trigger
 * the effect.
 */
export function useMobilePanelHeightTracker(id: string, element: HTMLElement | null) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));

  useEffect(() => {
    if (!isMobile || !element) {
      setHeight(id, null);
      return;
    }
    const update = () => {
      setHeight(id, element.getBoundingClientRect().height);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(element);
    return () => {
      ro.disconnect();
      setHeight(id, null);
    };
  }, [id, element, isMobile]);
}
