import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Run a style-dependent callback now and after each style rebuild.
 *
 * Installing sources and layers needs a parsed stylesheet, not loaded tiles:
 * `isStyleLoaded()` also waits for every source and image, so an unrelated
 * pending source or continuous animation would keep an overlay missing.
 * `getStyle()` returns undefined until parsing completes, but it serializes the
 * whole style, and `styledata` fires after nearly every style mutation. The
 * parsed state is therefore probed once per stylesheet and remembered until
 * `styledataloading` announces a replacement.
 *
 * While the stylesheet is unparsed, retries also run on idle and render:
 * continuous repaint can prevent idle, and a style that finished parsing before
 * this subscription existed emits no further load event.
 *
 * `apply` runs on every `styledata` and must therefore be idempotent. Adding a
 * source, layer or image inside it emits another `styledata`.
 */
export function subscribeStyleLoaded(map: MapLibreMap, apply: () => void): () => void {
  let disposed = false;
  let parsed = false;
  let waiting = false;

  function stopWaiting() {
    if (!waiting) return;
    map.off("idle", sync);
    map.off("render", sync);
    waiting = false;
  }

  function sync() {
    if (disposed) return;
    if (!parsed) {
      if (!map.getStyle()) {
        if (!waiting) {
          waiting = true;
          map.on("idle", sync);
          map.on("render", sync);
        }
        return;
      }
      parsed = true;
      stopWaiting();
    }
    apply();
  }

  function invalidate() {
    parsed = false;
  }

  sync();
  map.on("styledataloading", invalidate);
  map.on("style.load", sync);
  map.on("styledata", sync);

  return () => {
    disposed = true;
    map.off("styledataloading", invalidate);
    map.off("style.load", sync);
    map.off("styledata", sync);
    stopWaiting();
  };
}
