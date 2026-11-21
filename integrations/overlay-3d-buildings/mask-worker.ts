/// <reference lib="webworker" />
import type { BuildingReplacement } from "@openmapx/core";
import { rewriteBuildingTile } from "./building-mask";

interface RewriteRequest {
  id: number;
  bytes: Uint8Array;
  tile: { z: number; x: number; y: number };
  sourceLayer: string;
  replacements: BuildingReplacement[];
}

/** Rewrites building tiles off the main thread for the masked building source. */
self.onmessage = (event: MessageEvent<RewriteRequest>) => {
  // Only the page that created this dedicated worker can post to it, and such
  // messages carry no origin; verify anyway, as the service worker does.
  if (event.origin && event.origin !== self.location.origin) return;
  const { id, bytes, tile, sourceLayer, replacements } = event.data;
  try {
    const output = rewriteBuildingTile(bytes, tile, sourceLayer, replacements);
    (self as unknown as Worker).postMessage({ id, bytes: output }, [output.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: String(error) });
  }
};
