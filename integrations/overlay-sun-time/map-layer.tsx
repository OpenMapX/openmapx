"use client";

import { subsolarPoint, twilightBands } from "@openmapx/core";
import { useEffect, useMemo, useState } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/components/map/layers/layerStack";
import { useGeoJsonSourceDataBridge } from "@/components/map/layers/useGeoJsonSourceDataBridge";
import { useMap } from "@/lib/MapContext";
import { useSunTimeStore } from "./store";

const SOURCE_ID = "sun-time-terminator";
const BAND_COUNT = 16;
const BAND_LAYER_IDS = Array.from({ length: BAND_COUNT }, (_, i) => `sun-time-band-${i}`);

/** Per-layer alpha chosen so sixteen stacked fills accumulate to ~0.55 in deep night. */
const BAND_OPACITY = 1 - (1 - 0.55) ** (1 / BAND_COUNT);
const BAND_COLOR = "#0b1026";
const TICK_MS = 60_000;

/** Reserved contiguous block below every other area overlay: the shading is
 *  ambient, so place boundaries and imported geometry must read through it. */
const BAND_ORDER_BASE = -BAND_COUNT;

const SUBSOLAR_SOURCE_ID = "sun-time-subsolar-src";
const SUBSOLAR_LAYER_ID = "sun-time-subsolar";
const SUBSOLAR_IMAGE_ID = "sun-time-sun";
/** Above this the sun icon is noise; the shading itself keeps explaining local time. */
const SUBSOLAR_MAX_ZOOM = 4;

const SUN_ICON =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
      `<circle cx="14" cy="14" r="7" fill="#ffca28" stroke="#f9a825" stroke-width="1.5"/>` +
      `</svg>`,
  );

export default function SunTimeLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useSunTimeStore((s) => s.layerVisible);
  const showTerminator = useSunTimeStore((s) => s.showTerminator);
  const timeMs = useSunTimeStore((s) => s.timeMs);

  const active = layerVisible && showTerminator;

  // While following the wall clock the overlay redraws once a minute; a pinned
  // instant never ticks, so the interval is not created at all.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active || timeMs !== null) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active, timeMs]);

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

    const syncLayers = () => {
      if (!active) {
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
        const image = new Image(28, 28);
        image.onload = () => {
          if (!map.hasImage(SUBSOLAR_IMAGE_ID)) map.addImage(SUBSOLAR_IMAGE_ID, image);
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
          0,
        );
      }
    };

    syncLayers();
    if (!active) return;

    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
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
