"use client";

import { useNavigationStore, useRefreshTransitItinerary } from "@openmapx/core";
import { onlineManager } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/** How often to pull a fresh itinerary (delays/platforms/cancellations). */
const REFRESH_INTERVAL_MS = 30_000;

/**
 * While a transit trip is being navigated, periodically re-fetch the itinerary
 * from MOTIS (via the one-time, server-bound refresh token) so the delay chip,
 * ETA, platforms and any cancellations stay live instead of frozen at plan time.
 *
 * Each refresh consumes its token and the response carries a new one, so we
 * always read the latest token from the store. Only `transit-motis-local`
 * itineraries have a refresh token; for other providers this is a no-op and the
 * per-trip vehicle-journey polling still keeps the current leg's delay current.
 */
export function useTransitLiveRefresh(active: boolean): void {
  const refresh = useRefreshTransitItinerary();
  // Hold the latest mutateAsync so the interval effect need not depend on the
  // (unstable) mutation object, which would otherwise reset the timer.
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
      try {
        const response = await mutateRef.current(token);
        const next = response.data?.itinerary;
        const cur = useNavigationStore.getState();
        // Apply only if we're still on the same transit trip and no replan is
        // pending (a replan will swap the itinerary itself).
        if (
          next &&
          !cancelled &&
          cur.transitRequestId === requestId &&
          cur.itinerary?.refreshToken === token &&
          cur.status === "navigating" &&
          cur.kind === "transit" &&
          cur.navigationAuthority === "browser" &&
          !cur.transitRerouteNeeded
        ) {
          cur.updateItinerary(next);
          if (!next.refreshToken) cur.markTransitRefreshUnavailable(requestId);
        } else if (!cancelled && cur.itinerary?.refreshToken === token) {
          cur.markTransitRefreshUnavailable(requestId);
        }
      } catch {
        const cur = useNavigationStore.getState();
        if (!cancelled && cur.itinerary?.refreshToken === token)
          cur.markTransitRefreshUnavailable(requestId);
        // Keep the last itinerary; the vehicle-journey poll still updates the
        // current leg. A broken token chain simply means no more live refreshes.
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
        store.status === "navigating"
      )
        store.markTransitRefreshUnavailable(flight.requestId);
      inFlightRef.current = null;
      clearInterval(id);
    };
  }, [active]);
}
