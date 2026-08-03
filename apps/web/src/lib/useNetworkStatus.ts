"use client";

import { useEffect, useState } from "react";

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

/**
 * Live view of the connection's metered/Save-Data status. Returns
 * `{ supported: false, metered: false }` where the API is absent (Firefox,
 * Safari) so callers can simply skip any "are you on cellular?" warning.
 */
export function useNetworkStatus(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(() => read(getConnection()));

  useEffect(() => {
    const conn = getConnection();
    const onChange = () => setStatus(read(conn));
    onChange();
    conn?.addEventListener?.("change", onChange);
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    return () => {
      conn?.removeEventListener?.("change", onChange);
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
    };
  }, []);

  return status;
}
