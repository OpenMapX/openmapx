"use client";

import { useSyncExternalStore } from "react";

/** Minimal shape of the (non-standard) Network Information API. */
interface NetworkInformationLike {
  /** "slow-2g" | "2g" | "3g" | "4g" */
  effectiveType?: string;
  saveData?: boolean;
  /** "cellular" | "wifi" | "ethernet" | "none" | "unknown" | ... */
  type?: string;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}

export interface NetworkStatus {
  /** Browser's current reachability heuristic. */
  online: boolean;
  /** Whether the Network Information API is available at all. */
  supported: boolean;
  saveData: boolean;
  effectiveType: string | null;
  connectionType: string | null;
  /** Heuristic: Save-Data on, a cellular link, or a slow effective type. */
  metered: boolean;
}

function getConnection(): NetworkInformationLike | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };
  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
}

function read(conn: NetworkInformationLike | null): NetworkStatus {
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  if (!conn) {
    return {
      online,
      supported: false,
      saveData: false,
      effectiveType: null,
      connectionType: null,
      metered: false,
    };
  }
  const effectiveType = conn.effectiveType ?? null;
  const connectionType = conn.type ?? null;
  const saveData = conn.saveData === true;
  const slow = effectiveType === "slow-2g" || effectiveType === "2g" || effectiveType === "3g";
  const cellular = connectionType === "cellular";
  return {
    online,
    supported: true,
    saveData,
    effectiveType,
    connectionType,
    metered: saveData || cellular || slow,
  };
}

const serverSnapshot: NetworkStatus = {
  online: true,
  supported: false,
  saveData: false,
  effectiveType: null,
  connectionType: null,
  metered: false,
};

const listeners = new Set<() => void>();
let connection: NetworkInformationLike | null = null;
let snapshot: NetworkStatus | undefined;

function getSnapshot(): NetworkStatus {
  snapshot ??= read(getConnection());
  return snapshot;
}

function emitChange() {
  snapshot = read(connection);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    connection = getConnection();
    snapshot = read(connection);
    connection?.addEventListener?.("change", emitChange);
    window.addEventListener("online", emitChange);
    window.addEventListener("offline", emitChange);
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    connection?.removeEventListener?.("change", emitChange);
    window.removeEventListener("online", emitChange);
    window.removeEventListener("offline", emitChange);
    connection = null;
    snapshot = undefined;
  };
}

/**
 * Live view of the connection's metered/Save-Data status. Returns
 * `{ supported: false, metered: false }` where the API is absent (Firefox,
 * Safari) so callers can simply skip any "are you on cellular?" warning.
 */
export function useNetworkStatus(): NetworkStatus {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}
