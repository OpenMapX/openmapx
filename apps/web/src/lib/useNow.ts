"use client";

import { useEffect, useState } from "react";

/**
 * Current wall-clock time in epoch milliseconds, re-rendering on a fixed
 * interval. Drives live countdowns (e.g. the transit arrival countdown) that
 * must tick down on their own rather than only when some other state changes.
 *
 * The interval is cleared on unmount and re-armed if `intervalMs` changes.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
