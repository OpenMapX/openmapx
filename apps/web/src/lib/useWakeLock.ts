"use client";

import { useEffect, useRef } from "react";
import { hasCapability } from "./platformCapabilities";

/**
 * Hold a screen wake lock while `active`. Re-acquires when the tab becomes
 * visible again (the lock drops on hide). No-op when unsupported.
 */
export function useWakeLock(active: boolean): void {
  const lockRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active || !hasCapability("wakeLock")) return;
    let cancelled = false;
    let requesting = false;
    // Bumped on every acquire attempt. `request()` can take a tick, and a
    // second `visibilitychange` can fire while the first is still pending —
    // without a generation check both would resolve and store a sentinel,
    // leaking whichever one loses the race (nothing would ever release it).
    let generation = 0;

    const releaseSentinel = (sentinel: WakeLockSentinel) => {
      void sentinel.release().catch(() => {});
    };

    // The browser itself can drop the lock (e.g. another API takes it); when
    // it does, forget the sentinel so the next visibility change is free to
    // request a fresh one instead of believing a dead lock is still held.
    const onSentinelRelease = () => {
      lockRef.current = null;
    };

    const acquire = async () => {
      if (cancelled || requesting || lockRef.current) return;
      if (document.visibilityState !== "visible") return;
      requesting = true;
      const myGeneration = ++generation;
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        requesting = false;
        // The effect may have been cancelled, the tab hidden again, or a
        // later acquire already started while this request was in flight —
        // any of those makes this sentinel unwanted. Release it immediately
        // rather than storing it: a lock nobody released would hold the
        // screen awake indefinitely.
        if (cancelled || myGeneration !== generation || document.visibilityState !== "visible") {
          releaseSentinel(sentinel);
          return;
        }
        sentinel.addEventListener("release", onSentinelRelease);
        lockRef.current = sentinel;
      } catch {
        requesting = false;
        /* request can reject if not visible / denied — ignore */
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      generation++;
      document.removeEventListener("visibilitychange", onVisible);
      const sentinel = lockRef.current;
      lockRef.current = null;
      if (sentinel) {
        sentinel.removeEventListener("release", onSentinelRelease);
        releaseSentinel(sentinel);
      }
    };
  }, [active]);
}
