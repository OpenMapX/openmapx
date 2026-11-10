"use client";

import {
  CALLER_SHOWS_ERRORS,
  useNavigationStore,
  useRefreshTransitItinerary,
} from "@openmapx/core";
import { isApiClientError } from "@openmapx/core/navigation/api";
import { onlineManager } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/** How often to pull a fresh itinerary (delays/platforms/cancellations). */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * Refresh the selected itinerary with its server-bound token. Lost responses and
 * temporary failures can replay that token; terminal answers retire the chain.
 * Hosted itineraries without tokens are kept current by vehicle-journey polling.
 */
export function useTransitLiveRefresh(active: boolean): void {
  const refresh = useRefreshTransitItinerary(CALLER_SHOWS_ERRORS);
  const mutateRef = useRef(refresh.mutateAsync);
  mutateRef.current = refresh.mutateAsync;
  const inFlightRef = useRef<{ requestId: string | null; token: string } | null>(null);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    const tick = async () => {
      const store = useNavigationStore.getState();
      if (
        store.status !== "navigating" ||
        store.kind !== "transit" ||
        store.navigationAuthority !== "browser"
      )
        return;
      const requestId = store.transitRequestId;
      if (inFlightRef.current?.requestId === requestId) return;
      if (
        store.transitRerouteNeeded ||
        store.transitRefreshUnavailable ||
        store.connectivity === "offline" ||
        !onlineManager.isOnline()
      )
        return;
      const token = store.itinerary?.refreshToken;
      if (!token) return;

      const flight = { requestId, token };
      inFlightRef.current = flight;
      const isCurrent = () => {
        const cur = useNavigationStore.getState();
        return (
          !cancelled &&
          cur.transitRequestId === requestId &&
          cur.itinerary?.refreshToken === token &&
          cur.status === "navigating" &&
          cur.kind === "transit" &&
          cur.navigationAuthority === "browser"
        );
      };
      try {
        const response = await mutateRef.current(token);
        if (!isCurrent()) return;
        const cur = useNavigationStore.getState();
        const next = response.data?.itinerary;
        if (response.data?.fallbackOccurred) {
          cur.setTransitRerouteNeeded(true);
          cur.markTransitRefreshUnavailable(requestId);
        } else if (cur.transitRerouteNeeded) {
          cur.markTransitRefreshUnavailable(requestId);
        } else if (next) {
          cur.updateItinerary(next);
          if (!next.refreshToken) cur.markTransitRefreshUnavailable(requestId);
          else if (
            !useNavigationStore.getState().transitRefreshUnavailable &&
            response.freshness?.hasRealtimeData &&
            !response.freshness.isStale &&
            !response.freshness.isPartial
          )
            cur.setLiveDataUnavailable(cur.connectivity === "offline");
        } else {
          cur.setLiveDataUnavailable(true);
        }
      } catch (error) {
        if (!isCurrent()) return;
        const cur = useNavigationStore.getState();
        if (isApiClientError(error) && (error.status === 400 || error.status === 409))
          cur.markTransitRefreshUnavailable(requestId);
        else cur.setLiveDataUnavailable(true);
        // Keep the selected ride. A lost response can be replayed with this token.
      } finally {
        if (inFlightRef.current === flight) inFlightRef.current = null;
      }
    };

    const id = setInterval(tick, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      const flight = inFlightRef.current;
      const store = useNavigationStore.getState();
      if (
        flight &&
        store.transitRequestId === flight.requestId &&
        store.itinerary?.refreshToken === flight.token &&
        store.kind === "transit" &&
        store.status === "navigating" &&
        store.navigationAuthority === "browser"
      )
        store.setLiveDataUnavailable(true);
      inFlightRef.current = null;
      clearInterval(id);
    };
  }, [active]);
}
