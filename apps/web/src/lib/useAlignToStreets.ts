"use client";

import { useMapStore, useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useCallback, useRef } from "react";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { alignRefusalKey, announceAlign } from "./alignAnnouncement";
import { prefersReducedMotion } from "./reducedMotion";
import {
  ALIGN_MIN_ZOOM,
  alignmentCacheKey,
  computeStreetGridAlignment,
  type StreetGridAlignment,
} from "./streetGrid";

const ALIGN_EASE_MS = 300;
/**
 * Long enough to absorb a double tap, short enough that a retry after the tiles
 * finish painting gets a fresh answer — the camera key alone never changes when
 * the user simply asks again from the same spot.
 */
const ALIGN_MEMO_MS = 1000;

/**
 * Rotates the map so the local street grid runs up and down the screen, and
 * publishes what to say when it cannot — so every caller surfaces the same
 * words without choosing them.
 */
export function useAlignToStreets(): { available: boolean; align: () => void } {
  const t = useTranslations("map");
  const ctx = useMapOptional();
  const zoom = useMapStore((s) => s.zoom);
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const memo = useRef<{ key: string; at: number; result: StreetGridAlignment } | null>(null);
  const styleVersion = ctx?.styleVersion ?? 0;

  const align = useCallback((): void => {
    const announce = (status: StreetGridAlignment["status"]) => {
      const refusal = alignRefusalKey(status);
      if (refusal) announceAlign(t(refusal));
    };
    const map = ctx?.mapRef.current;
    if (!map) {
      announce("no-grid");
      return;
    }
    const key = alignmentCacheKey(map, styleVersion);
    const now = Date.now();
    const cached =
      memo.current?.key === key && now - memo.current.at < ALIGN_MEMO_MS ? memo.current : null;
    const result = cached?.result ?? computeStreetGridAlignment(map);
    // The window runs from the computation, not from the last tap: asking again
    // must not keep pushing a stale answer out of reach.
    memo.current = cached ?? { key, at: now, result };
    if (result.status === "ok") {
      map.easeTo(
        { bearing: result.bearing, duration: prefersReducedMotion() ? 0 : ALIGN_EASE_MS },
        { programmatic: true },
      );
    }
    announce(result.status);
  }, [ctx, styleVersion, t]);

  return { available: Boolean(ctx) && !navigating && zoom >= ALIGN_MIN_ZOOM, align };
}
