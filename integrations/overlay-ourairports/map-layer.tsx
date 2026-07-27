"use client";

import {
  createPlace,
  PANEL,
  useOverlayExclusion,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import { useOverlayMinZoom } from "@/lib/overlayZoomGate";
import { useIntegrationAttribution } from "@/lib/useIntegrationAttribution";
import { type AirportTypeFilter, useAirportsOverlayStore } from "./store";

const SOURCE_ID = "openmapx-airports-source";
const CIRCLE_LAYER_ID = "openmapx-airports-circles";
const LABEL_LAYER_ID = "openmapx-airports-labels";

/** Importance rank from the backend: 0 = large, 1 = medium, 2 = small, … */
const TYPE_COLORS: Array<[number, string]> = [
  [0, "#0ea5e9"], // large — sky blue
  [1, "#3b82f6"], // medium — blue
  [2, "#6366f1"], // small — indigo
  [3, "#0891b2"], // seaplane base — cyan
  [4, "#f97316"], // heliport — orange
  [5, "#a3a3a3"], // balloonport — neutral
  [6, "#94a3b8"], // closed — slate
];

const RANK_COLOR_EXPR = [
  "match",
  ["get", "rank"],
  ...TYPE_COLORS.flat(),
  "#475569",
] as unknown as maplibregl.ExpressionSpecification;

const CIRCLE_RADIUS_EXPR = [
  "interpolate",
  ["linear"],
  ["zoom"],
  4,
  ["match", ["get", "rank"], 0, 4, 1, 2.5, 2, 1, 3, 1, 4, 0.5, 0.5],
  8,
  ["match", ["get", "rank"], 0, 7, 1, 5, 2, 3, 3, 2.5, 4, 2, 1],
  12,
  ["match", ["get", "rank"], 0, 11, 1, 8, 2, 5, 3, 4, 4, 3.5, 2.5],
] as unknown as maplibregl.ExpressionSpecification;

/** Show labels above zoom 8 for large/medium airports, zoom 11+ for small. */
const LABEL_MIN_ZOOM = 8;
const LABEL_FILTER = [
  "any",
  ["<=", ["get", "rank"], 1],
  ["all", [">=", ["zoom"], 11], ["<=", ["get", "rank"], 2]],
] as unknown as maplibregl.FilterSpecification;

function typeQueryParams(filter: AirportTypeFilter): string {
  switch (filter) {
    case "scheduled":
      return "scheduledOnly=1";
    case "ifr":
      // Approximate "IFR-capable" via the type filter — small airports usually
      // include the VFR-only fields. Pragmatic single-source proxy without
      // crossing into FAA data.
      return "types=large_airport,medium_airport";
    case "with_iata":
      // No direct backend filter for "has IATA" — fall back to scheduled
      // service which is a near-superset. Lets us ship the filter without
      // adding a backend knob.
      return "scheduledOnly=1";
    default:
      return "";
  }
}

// Importing `maplibre-gl` types only — runtime instance comes from the page.
import type maplibregl from "maplibre-gl";

export function AirportsOverlay() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const env = useEnv();
  const layerVisible = useAirportsOverlayStore((s) => s.layerVisible);
  // Declared in this integration's manifest, the same gate the layer selector
  // applies: below it we skip fetching and keep the markers hidden, so an
  // overlay left on while zooming out can't pull a world-sized airport list.
  const minZoom = useOverlayMinZoom("ourairports");
  useIntegrationAttribution("overlay-ourairports", layerVisible);
  const filter = useAirportsOverlayStore((s) => s.filter);
  const setLoading = useAirportsOverlayStore((s) => s.setLoading);
  const setLastUpdated = useAirportsOverlayStore((s) => s.setLastUpdated);
  useOverlayExclusion("ourairports", layerVisible);
  useLayerReanchor([CIRCLE_LAYER_ID, LABEL_LAYER_ID], layerVisible);
  const fetchedKeyRef = useRef<string | null>(null);

  const fetchAirports = useCallback(async () => {
    const map = mapRef.current;
    // Checked before the fetched-key de-dup so a skipped fetch never claims
    // the key — crossing back over the threshold refetches the same viewport.
    if (!map || map.getZoom() < minZoom) return;
    const b = map.getBounds();
    const params = new URLSearchParams({
      west: String(b.getWest()),
      south: String(b.getSouth()),
      east: String(b.getEast()),
      north: String(b.getNorth()),
    });
    const filterQuery = typeQueryParams(filter);
    if (filterQuery) {
      for (const pair of filterQuery.split("&")) {
        const [k, v] = pair.split("=");
        if (k && v !== undefined) params.set(k, v);
      }
    }
    const url = `${env.apiUrl}/api/integrations/overlay-ourairports/airports?${params.toString()}`;
    const key = url;
    if (fetchedKeyRef.current === key) return;
    fetchedKeyRef.current = key;

    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (source) {
        source.setData(data);
        setLastUpdated(Date.now());
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [env, mapRef, filter, setLoading, setLastUpdated, minZoom]);

  // Layer add / remove + initial load
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayers = () => {
      if (!layerVisible) {
        try {
          if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
          if (map.getLayer(CIRCLE_LAYER_ID)) map.removeLayer(CIRCLE_LAYER_ID);
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        } catch {
          // tiles in flight
        }
        fetchedKeyRef.current = null;
        return;
      }

      try {
        if (!map.getSource(SOURCE_ID)) {
          map.addSource(SOURCE_ID, {
            type: "geojson",
            data: { type: "FeatureCollection", features: [] },
          });
        }
        const beforeLayer = getFirstSymbolLayerId(map);
        if (!map.getLayer(CIRCLE_LAYER_ID)) {
          map.addLayer(
            {
              id: CIRCLE_LAYER_ID,
              type: "circle",
              source: SOURCE_ID,
              minzoom: minZoom,
              paint: {
                "circle-radius": CIRCLE_RADIUS_EXPR,
                "circle-color": RANK_COLOR_EXPR,
                "circle-opacity": 0.85,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 1.2,
              },
            },
            beforeLayer,
          );
        }
        if (!map.getLayer(LABEL_LAYER_ID)) {
          map.addLayer(
            {
              id: LABEL_LAYER_ID,
              type: "symbol",
              source: SOURCE_ID,
              minzoom: LABEL_MIN_ZOOM,
              filter: LABEL_FILTER,
              layout: {
                "text-field": [
                  "coalesce",
                  ["get", "iata"],
                  ["get", "icao"],
                  ["get", "ident"],
                  ["get", "name"],
                ],
                "text-font": ["Noto Sans Bold"],
                "text-size": 11,
                "text-anchor": "top",
                "text-offset": [0, 0.8],
                "text-allow-overlap": false,
                "text-optional": true,
              },
              paint: {
                "text-color": "#0f172a",
                "text-halo-color": "#ffffff",
                "text-halo-width": 1.5,
              },
            },
            beforeLayer,
          );
        }
      } catch {
        map.once("idle", syncLayers);
      }
    };

    syncLayers();
    if (layerVisible) {
      void fetchAirports();
    }
    map.on("styledata", syncLayers);
    return () => {
      map.off("styledata", syncLayers);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible, fetchAirports, minZoom]);

  // Refetch on viewport change (debounced via moveend)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;
    const onMoveEnd = () => {
      void fetchAirports();
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [mapRef, mapReady, layerVisible, fetchAirports]);

  // Refetch when the filter changes — `fetchAirports` is recreated with the
  // new filter baked in, so its identity is the change signal here.
  useEffect(() => {
    if (!layerVisible) return;
    fetchedKeyRef.current = null;
    void fetchAirports();
  }, [layerVisible, fetchAirports]);

  // Click → open place panel via the coordinate scheme. The reverse-geocode
  // chain will resolve the aerodrome, and `knowledge-ourairports` will
  // re-attach the full runway / frequency / navaid record.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const onClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number | undefined>;
      // These layers render Point features; narrowing beats a cast, which
      // silently produced undefined coordinates for any other geometry.
      if (f.geometry.type !== "Point") return;
      const [lng, lat] = f.geometry.coordinates;
      const ident = String(p.ident ?? p.icao ?? p.iata ?? "")
        .trim()
        .toUpperCase();
      if (!ident) return;
      const name = String(p.name ?? ident);
      // Use the `oa:` place-resolver scheme so the panel surfaces the full
      // OurAirports detail (runways / frequencies / navaids) instead of
      // hitting Nominatim reverse-geocode at the click point, which can land
      // on a building inside the airport polygon and skip the enrichment.
      const place = createPlace({
        primaryScheme: "oa",
        ids: { oa: ident },
        name,
        address: "",
        coordinates: [lng, lat],
        category: "Airport",
        rawCategory: "aeroway/aerodrome",
      });
      usePlaceStore.getState().setSelectedPlace(place);
      // `setSelectedPlace` alone updates the URL but doesn't open the sidebar
      // — match the SearchBar's selection flow so the place panel actually
      // renders when the user clicks a marker.
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
    };

    const onMouseMove = (ev: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(CIRCLE_LAYER_ID)) return;
      const features = map.queryRenderedFeatures(ev.point, { layers: [CIRCLE_LAYER_ID] });
      map.getCanvasContainer().style.cursor = features.length > 0 ? "pointer" : "";
    };

    map.on("click", CIRCLE_LAYER_ID, onClick);
    map.on("mousemove", onMouseMove);
    INTERACTIVE_LAYER_IDS.add(CIRCLE_LAYER_ID);
    return () => {
      map.off("click", CIRCLE_LAYER_ID, onClick);
      map.off("mousemove", onMouseMove);
      map.getCanvasContainer().style.cursor = "";
      INTERACTIVE_LAYER_IDS.delete(CIRCLE_LAYER_ID);
    };
  }, [mapReady, mapRef, styleVersion, layerVisible]);

  return null;
}

export default AirportsOverlay;
