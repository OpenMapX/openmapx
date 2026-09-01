"use client";

import { useEffect, useSyncExternalStore } from "react";

export type MapEdge = "top" | "bottom" | "left" | "right";

export interface MapInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const ZERO_INSETS: MapInsets = { top: 0, bottom: 0, left: 0, right: 0 };

const entries = new Map<string, { edge: MapEdge; px: number }>();
const listeners = new Set<() => void>();
let cached: MapInsets = ZERO_INSETS;

function sameInsets(a: MapInsets, b: MapInsets): boolean {
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

function recompute(): boolean {
  const next: MapInsets = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const { edge, px } of entries.values()) {
    if (px > next[edge]) next[edge] = px;
  }
  if (sameInsets(next, cached)) return false;
  cached = next;
  return true;
}

/**
 * Registers how far a piece of chrome covers the map from one edge — the
 * distance from that viewport edge to the chrome's far side. Chrome that is
 * not on screen publishes `null` (or any non-positive value) to drop out.
 */
export function publishMapObstruction(id: string, edge: MapEdge, px: number | null): void {
  if (px == null || !Number.isFinite(px) || px <= 0) {
    if (!entries.delete(id)) return;
  } else {
    const current = entries.get(id);
    if (current && current.edge === edge && current.px === px) return;
    entries.set(id, { edge, px });
  }
  if (!recompute()) return;
  for (const listener of listeners) listener();
}

export function subscribeMapObstructions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The largest registered extent per edge. */
export function getMapObstructionInsets(): MapInsets {
  return cached;
}

const getServerSnapshot = () => ZERO_INSETS;

export function useMapObstructionInsets(): MapInsets {
  return useSyncExternalStore(subscribeMapObstructions, getMapObstructionInsets, getServerSnapshot);
}

/** Declarative registration for chrome whose extent is known from state. */
export function useMapObstruction(id: string, edge: MapEdge, px: number | null): void {
  useEffect(() => {
    publishMapObstruction(id, edge, px);
    return () => publishMapObstruction(id, edge, null);
  }, [id, edge, px]);
}

export function measuredExtent(
  edge: MapEdge,
  rect: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
): number {
  switch (edge) {
    case "top":
      return rect.bottom;
    case "bottom":
      return viewport.height - rect.top;
    case "left":
      return rect.right;
    case "right":
      return viewport.width - rect.left;
  }
}

/** Registration for chrome whose extent depends on its rendered box. */
export function useMeasuredMapObstruction(
  id: string,
  edge: MapEdge,
  element: HTMLElement | null,
): void {
  useEffect(() => {
    if (!element) {
      publishMapObstruction(id, edge, null);
      return;
    }
    const update = () => {
      publishMapObstruction(
        id,
        edge,
        measuredExtent(edge, element.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      publishMapObstruction(id, edge, null);
    };
  }, [id, edge, element]);
}
