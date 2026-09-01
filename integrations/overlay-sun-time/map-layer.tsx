"use client";

import { subsolarPoint, twilightBands, tzOffsetLabel, tzOffsetMinutes } from "@openmapx/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { addLayerInSlot, unregisterLayerSlot } from "@/integration-api/map/layerStack";
import type { GeoJsonSourceDataEntry } from "@/integration-api/map/layerStyleUtils";
import { useMap } from "@/integration-api/map/MapContext";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useIntegrationAttribution } from "@/integration-api/overlay/useIntegrationAttribution";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
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

const TZ_SOURCE_ID = "sun-time-timezones";
const TZ_FILL_LAYER_ID = "sun-time-tz-fill";
const TZ_LINE_LAYER_ID = "sun-time-tz-line";
const TZ_LABEL_LAYER_ID = "sun-time-tz-label";
/** Boundaries get noisy below whole-zone zoom; the fill also loses its point at city scale. */
const TZ_MAX_ZOOM = 8;

// The tint identifies "what zone am I in", which only matters once it reads
// through every other area overlay — not just the ambient terminator shading
// reserved at BAND_ORDER_BASE. 20/25/16 are each one above the current highest
// declared order in their slot (area-overlays/overlay-lines/overlay-markers);
// see layerStack.test.ts for the repo-wide collision guard these have to clear.
export const TZ_FILL_ORDER = 20;
const TZ_LINE_ORDER = 25;
const TZ_LABEL_ORDER = 16;

interface TimeZoneFeature {
  type: "Feature";
  properties: { tzid: string };
  geometry: GeoJSON.Geometry;
}

interface TimeZoneFeatureCollection {
  type: "FeatureCollection";
  features: TimeZoneFeature[];
}

interface DecoratedTimeZoneFeature {
  type: "Feature";
  properties: {
    tzid: string;
    offsetMinutes: number;
    offsetLabel: string;
    color: string;
  };
  geometry: GeoJSON.Geometry;
}

interface DecoratedTimeZones {
  type: "FeatureCollection";
  features: DecoratedTimeZoneFeature[];
}

export default function SunTimeLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useSunTimeStore((s) => s.layerVisible);
  const showTerminator = useSunTimeStore((s) => s.showTerminator);
  const showTimeZones = useSunTimeStore((s) => s.showTimeZones);
  const panelOpen = useSunTimeStore((s) => s.panelOpen);
  const timeMs = useSunTimeStore((s) => s.timeMs);
  const nowMs = useSunTimeStore((s) => s.nowMs);
  const setNowMs = useSunTimeStore((s) => s.setNowMs);
  const env = useEnv();
  const setTzLoading = useSunTimeStore((s) => s.setTzLoading);
  const tzActive = layerVisible && showTimeZones;

  // Credits the vendored boundary source only while the time zone toggle
  // itself is on, not merely while the overlay is — the terminator shading
  // owes nobody, so crediting it whenever the layer is visible would credit
  // a source for pixels it did not draw.
  useIntegrationAttribution("overlay-sun-time", tzActive);

  const [zones, setZones] = useState<TimeZoneFeatureCollection | null>(null);

  const active = layerVisible && showTerminator;

  // `visible` also has to cover tzActive: with only the terminator's `active`
  // here, toggling the time zone layer on while the terminator is off would
  // leave the bridge believing nothing is visible, and `publish()` below
  // would silently drop the decorated data instead of applying it.
  const { publish, clear, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: active || tzActive,
  });

  // Fetches once: the guard below bails out as soon as `zones` is set, and
  // ticking `instant` (from the shared 60s clock) is deliberately not a
  // dependency, so a clock tick can never refire this. Uses the bridge's
  // latest-wins request instead of a hand-rolled cancelled flag: `isLatest()`
  // stays true after the sub-toggle (or the whole overlay) turns off mid-fetch
  // — only a newer request or unmount flips it — so `tzLoading` still gets
  // reset instead of sticking on forever with the legend's progress bar.
  useEffect(() => {
    if (!tzActive || zones) return;
    const request = beginRequest();
    setTzLoading(true);
    fetch(`${env.apiUrl}/api/integrations/overlay-sun-time/timezones`, { signal: request.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: TimeZoneFeatureCollection | null) => {
        if (request.isCurrent() && data) setZones(data);
      })
      .catch(() => {
        // The overlay simply stays empty; the legend's loading bar clears below.
      })
      .finally(() => {
        if (request.isLatest()) setTzLoading(false);
      });
  }, [tzActive, zones, env.apiUrl, setTzLoading, beginRequest]);

  // The legend can be showing a clock (panelOpen) even while the shading
  // itself is hidden or switched off, so the tick has to keep the store's
  // `nowMs` current for either surface — not just for this layer's own paint.
  // `tzActive` also needs it: without a running clock, zone offsets freeze at
  // whatever `nowMs` held when the store was created instead of rolling over
  // the next hour or DST boundary.
  const clockNeeded = active || tzActive || panelOpen;

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

  // Cheap per-tick fingerprint of every zone's resolved offset. This recomputes
  // on every 60s clock tick (an Intl offset lookup per zone), but it only
  // changes at an hour or DST boundary — which is what lets `decoratedZones`
  // below skip rebuilding and re-serializing the whole ~1.3 MB decorated
  // FeatureCollection (a MapLibre worker reparse on setData) on every tick
  // that doesn't actually change anything on the map.
  const zoneOffsetSignature = useMemo(() => {
    if (!zones) return "";
    const at = new Date(instant);
    return zones.features
      .map(
        (feature) => `${feature.properties.tzid}:${tzOffsetMinutes(at, feature.properties.tzid)}`,
      )
      .join("|");
  }, [zones, instant]);

  // `instant` has to stay a real dependency below (it's used to build `at`),
  // but the cache keyed on `zoneOffsetSignature` returns the previous result
  // object — same identity — whenever a tick didn't change any zone's offset,
  // so `publish()` sees the same `data` reference and skips the source update.
  const decoratedZonesCache = useRef<{
    zones: TimeZoneFeatureCollection | null;
    signature: string;
    result: DecoratedTimeZones | null;
  }>({ zones: null, signature: "", result: null });

  const decoratedZones = useMemo(() => {
    if (!zones) return null;
    const cache = decoratedZonesCache.current;
    if (cache.zones === zones && cache.signature === zoneOffsetSignature) {
      return cache.result;
    }
    const at = new Date(instant);
    const result: DecoratedTimeZones = {
      type: "FeatureCollection",
      // tzOffsetMinutes/tzOffsetLabel return null for a zone id the platform
      // doesn't recognise. The vendored file is validated at generation time,
      // so this shouldn't fire — but a stale id must drop that one polygon,
      // not poison the whole layer with a NaN hue and an invalid hsl() color.
      features: zones.features.flatMap((feature) => {
        const offsetMinutes = tzOffsetMinutes(at, feature.properties.tzid);
        const offsetLabel = tzOffsetLabel(at, feature.properties.tzid);
        if (offsetMinutes === null || offsetLabel === null) return [];
        const hue = ((((offsetMinutes / 60) * 15) % 360) + 360) % 360;
        return [
          {
            ...feature,
            properties: {
              ...feature.properties,
              offsetMinutes,
              offsetLabel,
              color: `hsl(${Math.round(hue)}, 55%, 55%)`,
            },
          },
        ];
      }),
    };
    decoratedZonesCache.current = { zones, signature: zoneOffsetSignature, result };
    return result;
  }, [zones, instant, zoneOffsetSignature]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // Guards a `map.once("idle", syncLayers)` scheduled by this effect run:
    // if the overlay is hidden (or the component unmounts) mid-style-load,
    // the cleanup below flips this before the idle event fires, so the stale
    // closure bails out instead of re-adding layers nobody wants anymore.
    let disposed = false;

    const teardownTerminator = () => {
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

    const teardownTimeZones = () => {
      for (const id of [TZ_FILL_LAYER_ID, TZ_LINE_LAYER_ID, TZ_LABEL_LAYER_ID]) {
        try {
          if (map.getLayer(id)) map.removeLayer(id);
        } catch {
          // The style may already have dropped it during a base-map swap.
        }
        unregisterLayerSlot(id);
      }
      try {
        if (map.getSource(TZ_SOURCE_ID)) map.removeSource(TZ_SOURCE_ID);
      } catch {
        // ignore
      }
    };

    const syncLayers = () => {
      if (disposed) return;
      if (!active && !tzActive) {
        teardownTerminator();
        teardownTimeZones();
        return;
      }

      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayers);
        return;
      }

      if (active) {
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
      } else {
        teardownTerminator();
      }

      if (tzActive) {
        if (!map.getSource(TZ_SOURCE_ID)) {
          map.addSource(TZ_SOURCE_ID, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }

        if (!map.getLayer(TZ_FILL_LAYER_ID)) {
          addLayerInSlot(
            map,
            {
              id: TZ_FILL_LAYER_ID,
              type: "fill",
              source: TZ_SOURCE_ID,
              maxzoom: TZ_MAX_ZOOM,
              paint: {
                "fill-color": ["get", "color"],
                "fill-opacity": 0.18,
                "fill-antialias": false,
              },
            },
            "area-overlays",
            TZ_FILL_ORDER,
          );
        }

        if (!map.getLayer(TZ_LINE_LAYER_ID)) {
          addLayerInSlot(
            map,
            {
              id: TZ_LINE_LAYER_ID,
              type: "line",
              source: TZ_SOURCE_ID,
              maxzoom: TZ_MAX_ZOOM,
              paint: { "line-color": ["get", "color"], "line-width": 1, "line-opacity": 0.4 },
            },
            "overlay-lines",
            TZ_LINE_ORDER,
          );
        }

        if (!map.getLayer(TZ_LABEL_LAYER_ID)) {
          // MapLibre places point symbols for polygon features at a computed
          // interior point, so the label layer needs no centroid pass and no
          // turf dependency.
          addLayerInSlot(
            map,
            {
              id: TZ_LABEL_LAYER_ID,
              type: "symbol",
              source: TZ_SOURCE_ID,
              minzoom: 2,
              maxzoom: TZ_MAX_ZOOM,
              layout: {
                "text-field": ["get", "offsetLabel"],
                "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
                "text-size": 11,
              },
              paint: {
                "text-color": "#ffffff",
                "text-halo-color": "rgba(0,0,0,0.5)",
                "text-halo-width": 1,
              },
            },
            "overlay-markers",
            TZ_LABEL_ORDER,
          );
        }
      } else {
        teardownTimeZones();
      }
    };

    syncLayers();
    if (active || tzActive) map.on("styledata", syncLayers);

    // Runs on every dep change, not just true unmount: disposing here cancels
    // any pending idle callback from this run, and tearing down unconditionally
    // (not just when `active`/`tzActive` flip off) is what stops the band
    // layers, the time zone layers, their sources, and their layerStack slots
    // from being stranded if the component unmounts — e.g. the overlay
    // integration is disabled at runtime — while still active. Every call is
    // idempotent when there is nothing to do.
    return () => {
      disposed = true;
      if (active || tzActive) map.off("styledata", syncLayers);
      teardownTerminator();
      teardownTimeZones();
    };
  }, [mapRef, mapReady, styleVersion, active, tzActive]);

  useEffect(() => {
    // The bridge is all-or-nothing: apply() skips every setData call if any
    // one retained source is missing, and publish() never drops a source from
    // the retained set on its own. Without these, turning one sub-toggle off
    // would leave its source retained-but-gone, and the *other* sub-layer's
    // otherwise-still-valid entry would stop applying right along with it.
    if (!active) clear([SOURCE_ID, SUBSOLAR_SOURCE_ID]);
    if (!tzActive || !decoratedZones) clear([TZ_SOURCE_ID]);

    const entries: GeoJsonSourceDataEntry[] = [];
    if (active) {
      entries.push({ sourceId: SOURCE_ID, data: bands });
      entries.push({ sourceId: SUBSOLAR_SOURCE_ID, data: subsolar });
    }
    if (tzActive && decoratedZones) {
      entries.push({ sourceId: TZ_SOURCE_ID, data: decoratedZones });
    }
    if (entries.length > 0) publish(entries);
  }, [active, tzActive, bands, subsolar, decoratedZones, publish, clear]);

  return null;
}
