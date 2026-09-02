"use client";

import { useSyncExternalStore } from "react";
import type { StreetGridAlignment } from "./streetGrid";

/** Message key, in the `map` namespace, for each outcome that moves nothing. */
const REFUSAL_KEYS = {
  "no-grid": "alignNoGrid",
  "zoomed-out": "alignZoomIn",
  aligned: "alignAlready",
} as const;

export type AlignRefusalKey = (typeof REFUSAL_KEYS)[keyof typeof REFUSAL_KEYS];

/**
 * What to tell the user about an align request, or null when the map rotated —
 * a rotation is self-evident on screen, and nothing moving needs a reason.
 */
export function alignRefusalKey(status: StreetGridAlignment["status"]): AlignRefusalKey | null {
  return status === "ok" ? null : REFUSAL_KEYS[status];
}

export interface AlignAnnouncement {
  text: string;
  /**
   * Makes a repeat of the same words a new value: asking twice has to
   * re-announce and restart the toast, and identical state would do neither.
   */
  seq: number;
}

let announcement: AlignAnnouncement | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Publishes the outcome of an align request for the map chrome to surface,
 * wherever the request came from — the on-map control, the command palette.
 */
export function announceAlign(text: string): void {
  announcement = { text, seq: (announcement?.seq ?? 0) + 1 };
  emit();
}

export function clearAlignAnnouncement(): void {
  if (!announcement) return;
  announcement = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    // The channel outlives any one component. An unread message left behind
    // would be replayed by the next mount — a toast, and an announcement, about
    // a map interaction that is no longer on screen.
    if (listeners.size === 0) announcement = null;
  };
}

const getSnapshot = () => announcement;
const getServerSnapshot = () => null;

export function useAlignAnnouncement(): AlignAnnouncement | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
