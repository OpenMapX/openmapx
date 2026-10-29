"use client";

import { useSyncExternalStore } from "react";

/**
 * The map footer's bottom-edge obstruction. Chrome that stands on the footer
 * reads this registration directly (`useMapObstructionExtent`): the footer
 * republishes it in the same frame it follows a moving sheet.
 */
export const MAP_FOOTER_OBSTRUCTION_ID = "map-footer";

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

export function getMapFooterCenterCovered(): boolean {
  return covered;
}

const getServerSnapshot = () => false;

export function useMapFooterCenterCovered(): boolean {
  return useSyncExternalStore(subscribe, getMapFooterCenterCovered, getServerSnapshot);
}

/** Whether the footer rides inside the mobile sheet, and its own height. */
export interface MapFooterBox {
  docked: boolean;
  height: number;
}

let box: MapFooterBox = { docked: false, height: 0 };
const boxListeners = new Set<() => void>();

/**
 * Published as the footer moves between the map and the sheet or resizes.
 * Chrome standing on an undocked footer while it rides the sheet needs these
 * two constants, not the footer's moving position.
 */
export function publishMapFooterBox(next: MapFooterBox): void {
  if (next.docked === box.docked && next.height === box.height) return;
  box = next;
  for (const listener of boxListeners) listener();
}

function subscribeBox(listener: () => void): () => void {
  boxListeners.add(listener);
  return () => {
    boxListeners.delete(listener);
  };
}

const getBox = () => box;
const SERVER_BOX: MapFooterBox = { docked: false, height: 0 };

export function useMapFooterBox(): MapFooterBox {
  return useSyncExternalStore(subscribeBox, getBox, () => SERVER_BOX);
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
