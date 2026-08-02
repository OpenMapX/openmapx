"use client";

import type maplibregl from "maplibre-gl";
import { useEffect, useState } from "react";
import { useMap } from "@/lib/MapContext";

/**
 * Creates a layer's sources and layers so they survive a style change.
 *
 * `setStyle` — a dark/light swap, a basemap switch, a satellite toggle — drops
 * every source and layer the app added. Recovering from that cannot rely on the
 * `styleVersion` counter alone: it is bumped from a one-shot `style.load`
 * listener attached after the swap is requested, so a style that resolves from
 * cache can land before anyone is listening, and the counter never moves. A
 * layer keyed only on that counter then stays missing for the rest of the
 * session. Re-running on the map's own recurring `styledata` event is what makes
 * recovery unconditional.
 *
 * `create` is called only when `sourceId` is absent, so it is safe to invoke on
 * every `styledata`. The returned epoch increments each time it actually ran,
 * which is the signal a data effect needs: recreated sources come back empty, so
 * whatever pushes geometry into them has to run again or the map stays blank.
 *
 * @param sourceId the source whose presence means "already set up"
 * @param create adds the sources and layers; runs with a loaded style
 * @returns a counter that increments on every (re)creation
 */
export function useStyleSyncedSetup(
  sourceId: string,
  create: (map: maplibregl.Map) => void,
): number {
  const { mapRef, mapReady, styleVersion } = useMap();
  const [epoch, setEpoch] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `create` is re-read through the closure on each run; adding it would re-register the listener on every render
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const run = () => {
      // A style mid-load rejects addSource/addLayer outright, so wait for it to
      // settle rather than losing the layer to a throw.
      if (!map.isStyleLoaded()) {
        map.once("idle", run);
        return;
      }
      if (map.getSource(sourceId)) return;
      create(map);
      setEpoch((value) => value + 1);
    };

    run();
    map.on("styledata", run);
    return () => {
      map.off("styledata", run);
      map.off("idle", run);
    };
  }, [mapRef, mapReady, styleVersion, sourceId]);

  return epoch;
}
