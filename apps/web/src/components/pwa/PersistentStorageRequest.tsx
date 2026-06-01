"use client";

import { useEffect } from "react";
import { requestPersistentStorage } from "@/lib/persistentStorage";
import { useInstallPrompt } from "./useInstallPrompt";

/**
 * When running as an installed PWA, proactively request persistent storage so
 * the service-worker registration and offline caches survive eviction — the
 * root cause of "offline launch shows the browser's connection error" rather
 * than the cached map. Gated on `installed` so a casual browser tab never
 * triggers Firefox's permission prompt unprompted; the explicit
 * offline-area download is the other, in-context place we ask. Chrome grants
 * persistence silently for installed PWAs, so this is usually a no-op there.
 * See `lib/persistentStorage`.
 */
export function PersistentStorageRequest(): null {
  const { installed } = useInstallPrompt();

  useEffect(() => {
    if (!installed) return;
    void requestPersistentStorage();
  }, [installed]);

  return null;
}
