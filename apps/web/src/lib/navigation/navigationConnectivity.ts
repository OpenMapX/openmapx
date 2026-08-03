"use client";

import type { NavigationConnectivity } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { useEffect } from "react";

export function readNavigationConnectivity(): NavigationConnectivity {
  return typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "online";
}

/** Network failures are intentionally narrow: HTTP errors are server failures, not connectivity. */
export function isConnectivityFailure(
  error: unknown,
  connectivity: NavigationConnectivity,
): boolean {
  if (connectivity === "offline") return true;
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; message?: unknown };
  if (value.name === "NetworkError" || value.name === "OfflineError") return true;
  return (
    typeof value.message === "string" && /network|failed to fetch|offline/i.test(value.message)
  );
}

/** Keep one typed browser connectivity signal in the navigation store. */
export function useNavigationConnectivity(): NavigationConnectivity {
  const connectivity = useNavigationStore((state) => state.connectivity);
  const setConnectivity = useNavigationStore((state) => state.setConnectivity);

  useEffect(() => {
    const sync = () => setConnectivity(readNavigationConnectivity());
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, [setConnectivity]);

  return connectivity;
}
