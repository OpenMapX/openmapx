"use client";

import { subsolarPoint, twilightBands } from "@openmapx/core";
import { useEffect, useMemo } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { useGeoJsonSourceDataBridge } from "@/components/map/layers/useGeoJsonSourceDataBridge";
import { useMap } from "@/lib/MapContext";
import { useSunTimeStore } from "./store";

const SOURCE_ID = "sun-time-terminator";
export const BAND_COUNT = 16;
const BAND_LAYER_IDS = Array.from({ length: BAND_COUNT }, (_, i) => `sun-time-band-${i}`);

/** Per-layer alpha chosen so sixteen stacked fills accumulate to ~0.55 in deep night. */
export const BAND_OPACITY = 1 - (1 - 0.55) ** (1 / BAND_COUNT);
export const BAND_COLOR = "#0b1026";
const TICK_MS = 60_000;

/** Reserved contiguous block below every other area overlay: the shading is
 *  ambient, so place boundaries and imported geometry must read through it. */
export const BAND_ORDER_BASE = -BAND_COUNT;

const SUBSOLAR_SOURCE_ID = "sun-time-subsolar-src";
const SUBSOLAR_LAYER_ID = "sun-time-subsolar";
const SUBSOLAR_IMAGE_ID = "sun-time-sun";
/** Above this the sun icon is noise; the shading itself keeps explaining local time. */
const SUBSOLAR_MAX_ZOOM = 4;
/** Ambient world-zoom decoration, placed below all other markers in the overlay-markers slot. */
const SUBSOLAR_ORDER = -1;

// Drawn at 2x (56x56) and registered with pixelRatio 2 so it stays crisp on
// retina while occupying 28x28 logical px on the map.
const SUN_ICON =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">` +
      `<circle cx="28" cy="28" r="14" fill="#ffca28" stroke="#f9a825" stroke-width="3"/>` +
      `</svg>`,
  );

export default function SunTimeLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useSunTimeStore((s) => s.layerVisible);
  const showTerminator = useSunTimeStore((s) => s.showTerminator);
  const panelOpen = useSunTimeStore((s) => s.panelOpen);
  const timeMs = useSunTimeStore((s) => s.timeMs);
  const nowMs = useSunTimeStore((s) => s.nowMs);
  const setNowMs = useSunTimeStore((s) => s.setNowMs);

  const active = layerVisible && showTerminator;
  // The legend can be showing a clock (panelOpen) even while the shading
  // itself is hidden or switched off, so the tick has to keep the store's
  // `nowMs` current for either surface — not just for this layer's own paint.
  const clockNeeded = active || panelOpen;

  // This is the ONLY timer for "now" in the sun-time overlay: it writes into
  // the shared store field instead of local state so the legend (which reads
  // the same field) can never end up ticking on a second, independently
  // drifting interval. A pinned instant never ticks, so the interval is not
  // created at all.
  useEffect(() => {
    if (!clockNeeded || timeMs !== null) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [clockNeeded, timeMs, setNowMs]);

  const instant = timeMs ?? nowMs;
  const bands = useMemo(() => twilightBands(new Date(instant), { bands: BAND_COUNT }), [instant]);
  const subsolar = useMemo(() => {
    const { lng, lat } = subsolarPoint(new Date(instant));
    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [lng, lat] },
          properties: {},
        },
      ],
    };
  }, [instant]);

  const { publish, clear } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: active,
  });

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Guards a `map.once("idle", syncLayers)` scheduled by this effect run:
    // if the overlay is hidden (or the component unmounts) mid-style-load,
    // the cleanup below flips this before the idle event fires, so the stale
    // closure bails out instead of re-adding layers nobody wants anymore.
    let disposed = false;

    const teardown = () => {
      for (const id of BAND_LAYER_IDS) {
        try {
          if (map.getLayer(id)) map.removeLayer(id);
        } catch {
          // The style may already have dropped it during a base-map swap.
        }
        unregisterLayerSlot(id);
      }
      try {
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // ignore
      }
      try {
        if (map.getLayer(SUBSOLAR_LAYER_ID)) map.removeLayer(SUBSOLAR_LAYER_ID);
        if (map.getSource(SUBSOLAR_SOURCE_ID)) map.removeSource(SUBSOLAR_SOURCE_ID);
      } catch {
        // ignore
      }
      unregisterLayerSlot(SUBSOLAR_LAYER_ID);
    };

    const syncLayers = () => {
      if (disposed) return;
      if (!active) {
        teardown();
        return;
      }

      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayers);
        return;
      }

      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      BAND_LAYER_IDS.forEach((id, band) => {
        if (map.getLayer(id)) return;
        addLayerInSlot(
          map,
          {
            id,
            type: "fill",
            source: SOURCE_ID,
            filter: ["==", ["get", "band"], band],
            paint: {
              "fill-color": BAND_COLOR,
              "fill-opacity": BAND_OPACITY,
              "fill-antialias": false,
            },
          },
          "area-overlays",
          BAND_ORDER_BASE + band,
        );
      });

      if (!map.hasImage(SUBSOLAR_IMAGE_ID)) {
        const image = new Image(56, 56);
        image.onload = () => {
          if (!map.hasImage(SUBSOLAR_IMAGE_ID)) {
            map.addImage(SUBSOLAR_IMAGE_ID, image, { pixelRatio: 2 });
          }
        };
        image.src = SUN_ICON;
      }

      if (!map.getSource(SUBSOLAR_SOURCE_ID)) {
        map.addSource(SUBSOLAR_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }

      if (!map.getLayer(SUBSOLAR_LAYER_ID)) {
        addLayerInSlot(
          map,
          {
            id: SUBSOLAR_LAYER_ID,
            type: "symbol",
            source: SUBSOLAR_SOURCE_ID,
            maxzoom: SUBSOLAR_MAX_ZOOM,
            layout: {
              "icon-image": SUBSOLAR_IMAGE_ID,
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          },
          "overlay-markers",
          SUBSOLAR_ORDER,
        );
      }
    };

    syncLayers();
    if (active) map.on("styledata", syncLayers);

    // Runs on every dep change, not just true unmount: disposing here cancels
    // any pending idle callback from this run, and tearing down unconditionally
    // (not just when `active` flips off) is what stops the 16 band layers, the
    // source, and their layerStack slots from being stranded if the component
    // unmounts — e.g. the overlay integration is disabled at runtime — while
    // still active. Both calls are idempotent when there is nothing to do.
    return () => {
      disposed = true;
      if (active) map.off("styledata", syncLayers);
      teardown();
    };
  }, [mapRef, mapReady, styleVersion, active]);

  useEffect(() => {
    if (!active) {
      clear([SOURCE_ID, SUBSOLAR_SOURCE_ID]);
      return;
    }
    publish([
      { sourceId: SOURCE_ID, data: bands },
      { sourceId: SUBSOLAR_SOURCE_ID, data: subsolar },
    ]);
  }, [active, bands, subsolar, publish, clear]);

  return null;
}
