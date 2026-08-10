"use client";

import { useCallback, useRef } from "react";
import {
  browserForegroundFix,
  type ForegroundLocationOptions,
  type ForegroundLocationResult,
  nativeForegroundFix,
} from "./foregroundLocation";
import { useMobileRuntimeContext } from "./MobileRuntimeProvider";

/**
 * The one-fix adapter every "where am I" button uses.
 *
 * Routes to the browser or the shell according to authority, and — importantly
 * — never to both. A page that fell back to browser geolocation when the shell
 * could not answer would restore the second location producer that the whole
 * native-authority split exists to remove.
 */
export function useForegroundLocation() {
  const runtime = useMobileRuntimeContext();
  const counter = useRef(0);

  return useCallback(
    async (options: ForegroundLocationOptions = {}): Promise<ForegroundLocationResult> => {
      if (runtime.browserAuthority) return browserForegroundFix(options);
      if (!runtime.client || runtime.state !== "native-compatible") {
        return { status: "unavailable" };
      }
      counter.current += 1;
      // Per-request so a slow answer to an abandoned request cannot move the map
      // under someone who has since asked again.
      const requestId = `fix-${counter.current}`;
      return nativeForegroundFix(runtime.client, requestId, options);
    },
    [runtime],
  );
}
