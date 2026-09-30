"use client";

import { useSyncExternalStore } from "react";

/** Width of the legend show/hide tab centred on the map's bottom edge. */
export const LEGEND_TOGGLE_WIDTH = 54;

/** Clear space kept on each side of the legend tab before footer text counts as under it. */
const CENTER_MARGIN = 8;

let covered = false;
const listeners = new Set<() => void>();

/**
 * Whether any footer content lies in the centre column the legend tab
 * occupies. The tab sits flush on the map's bottom edge over the gap between
 * the legal links and the credits; only when footer text runs under it (long
 * or wrapped credits) does it need to move up onto the footer.
 */
export function publishMapFooterCenterCovered(next: boolean): void {
  if (next === covered) return;
  covered = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => covered;
const getServerSnapshot = () => false;

export function useMapFooterCenterCovered(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * True when any of `boxes` reaches into the centre column of `footer`, which
 * spans the same visible map width the legend tab is centred on.
 */
export function coversFooterCenter(
  footer: { left: number; right: number },
  boxes: ReadonlyArray<{ left: number; right: number; width: number }>,
): boolean {
  const center = (footer.left + footer.right) / 2;
  const half = LEGEND_TOGGLE_WIDTH / 2 + CENTER_MARGIN;
  return boxes.some(
    (box) => box.width > 0 && box.left < center + half && box.right > center - half,
  );
}
