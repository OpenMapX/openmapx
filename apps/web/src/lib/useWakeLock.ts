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

    const acquire = async () => {
      try {
        if (document.visibilityState !== "visible") return;
        lockRef.current = await navigator.wakeLock.request("screen");
      } catch {
        /* request can reject if not visible / denied — ignore */
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && !cancelled) void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lockRef.current?.release().catch(() => {});
      lockRef.current = null;
    };
  }, [active]);
}
