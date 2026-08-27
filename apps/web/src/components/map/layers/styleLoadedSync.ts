import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Run a style-dependent callback now and after each style rebuild. While the
 * style is loading, keep exactly one idle retry and remove it on replacement
 * or teardown so an obsolete effect can never mutate the new style.
 */
export function subscribeStyleLoaded(map: MapLibreMap, apply: () => void): () => void {
  let disposed = false;
  let idleRetryScheduled = false;

  const onIdle = () => {
    if (idleRetryScheduled) {
      map.off("idle", onIdle);
      idleRetryScheduled = false;
    }
    sync();
  };

  function sync() {
    if (disposed) return;
    if (!map.isStyleLoaded()) {
      if (!idleRetryScheduled) {
        idleRetryScheduled = true;
        map.once("idle", onIdle);
      }
      return;
    }

    if (idleRetryScheduled) {
      map.off("idle", onIdle);
      idleRetryScheduled = false;
    }
    apply();
  }

  sync();
  map.on("styledata", sync);

  return () => {
    disposed = true;
    map.off("styledata", sync);
    if (idleRetryScheduled) {
      map.off("idle", onIdle);
      idleRetryScheduled = false;
    }
  };
}
