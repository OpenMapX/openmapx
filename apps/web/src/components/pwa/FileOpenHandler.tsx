"use client";

import { useEffect } from "react";
import { importGeoFromFile } from "@/lib/importGeoFile";

interface LaunchParams {
  files?: FileSystemFileHandle[];
}
interface LaunchQueue {
  setConsumer: (consumer: (params: LaunchParams) => void) => void;
}

/**
 * Consumes files the OS hands the installed PWA via the File Handling API (when
 * the user opens a .gpx/.geojson/.kml with OpenMapX). Parses each and draws it
 * on the map. No-op where `launchQueue` is unavailable (non-Chromium / browser
 * tab). The in-app menu importer is the universal path.
 */
export function FileOpenHandler(): null {
  useEffect(() => {
    const launchQueue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
    if (!launchQueue) return;
    launchQueue.setConsumer((params) => {
      // The map holds a single imported overlay, so open just the first file
      // rather than importing several and silently keeping only the last.
      const handle = params.files?.[0];
      if (!handle) return;
      void (async () => {
        try {
          const file = await handle.getFile();
          await importGeoFromFile(file);
        } catch {
          // ignore unreadable handles
        }
      })();
    });
  }, []);

  return null;
}
