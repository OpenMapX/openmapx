"use client";

import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useEffect, useSyncExternalStore } from "react";

const heights = new Map<string, number>();
const listeners = new Set<() => void>();
let cachedMax = 0;

const caps = new Map<string, number>();
let cachedCap: number | null = null;

/**
 * Fallback cap for panels that register no cap of their own (the navigation
 * swipe sheet). Above this the panel covers the map controls anyway, so
 * following it further would push them off the top of the visible map.
 */
const DEFAULT_FOLLOW_CAP_FRACTION = 0.65;

function recomputeMax() {
  let max = 0;
  for (const v of heights.values()) {
    if (v > max) max = v;
  }
  cachedMax = max;
}

function recomputeCap() {
  let min: number | null = null;
  for (const v of caps.values()) {
    if (min == null || v < min) min = v;
  }
  cachedCap = min;
}

function emit() {
  recomputeMax();
  recomputeCap();
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

function setCap(id: string, cap: number | null) {
  if (cap == null || cap <= 0) {
    if (!caps.delete(id)) return;
  } else {
    if (caps.get(id) === cap) return;
    caps.set(id, cap);
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

const getCapSnapshot = () => cachedCap;
const getServerCapSnapshot = (): number | null => null;

function subscribeWindowHeight(listener: () => void) {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

const getWindowHeightSnapshot = () => window.innerHeight;
const getServerWindowHeightSnapshot = () => 0;

/** Hydration-safe live height of the browser's layout viewport. */
export function useWindowHeight(): number {
  return useSyncExternalStore(
    subscribeWindowHeight,
    getWindowHeightSnapshot,
    getServerWindowHeightSnapshot,
  );
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

/**
 * Publishes a panel's height directly, for panels whose rendered height is not
 * the box of any single element — the bottom sheet's host is a fixed-height
 * scroll container, so its visible height is derived, not measured.
 */
export function publishMobilePanelHeight(id: string, px: number | null) {
  setHeight(id, px);
}

/** Publishes how far UI anchored above a panel should follow it. */
export function useMobilePanelFollowCap(id: string, capPx: number | null) {
  useEffect(() => {
    setCap(id, capPx);
    return () => setCap(id, null);
  }, [id, capPx]);
}

/**
 * Height (px) that map chrome should clear to sit above the mobile panels —
 * the tallest registered panel, clamped by the tightest registered cap.
 */
export function useMobilePanelClearance(viewportHeight: number): number {
  const height = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const cap = useSyncExternalStore(subscribe, getCapSnapshot, getServerCapSnapshot);
  if (cap != null) return Math.min(height, cap);
  return viewportHeight > 0
    ? Math.min(height, viewportHeight * DEFAULT_FOLLOW_CAP_FRACTION)
    : height;
}
