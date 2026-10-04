import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Run a style-dependent callback now and after each style rebuild. While the
 * stylesheet is unparsed, retry on idle or render. `getStyle()` returns
 * undefined until parsing completes; unlike `isStyleLoaded()`, it does not
 * wait for all source tiles and images. Continuous repaint can prevent idle,
 * so render is observed only while waiting for the parsed stylesheet.
 */
export function subscribeStyleLoaded(map: MapLibreMap, apply: () => void): () => void {
  let disposed = false;
  let retryScheduled = false;

  function clearRetry() {
    if (!retryScheduled) return;
    map.off("idle", sync);
    map.off("render", sync);
    retryScheduled = false;
  }

  function sync() {
    if (disposed) return;
    if (!map.getStyle()) {
      if (!retryScheduled) {
        retryScheduled = true;
        map.on("idle", sync);
        map.on("render", sync);
      }
      return;
    }

    clearRetry();
    apply();
  }

  sync();
  map.on("style.load", sync);
  map.on("styledata", sync);

  return () => {
    disposed = true;
    map.off("style.load", sync);
    map.off("styledata", sync);
    clearRetry();
  };
}
