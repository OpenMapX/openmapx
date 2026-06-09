"use client";

import { API_ENDPOINTS, apiClient, routeColor } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MobilityEnvelope } from "@openmapx/mobility-core/result";
import type { TransitRoute } from "@openmapx/mobility-core/transit";
import type { GeoJSONSource } from "maplibre-gl";
import { useEffect, useState } from "react";
import {
  findVectorLineReference,
  getFirstSymbolLayerId,
  moveLayerBeforeFirstSymbol,
  setLayerVisibility,
} from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useMap } from "@/lib/MapContext";
import { PRIMARY_BLUE_HEX } from "@/lib/theme";
import { useMapAttributions } from "@/lib/useMapAttributions";
import { useTransitStore } from "./store";

const TRANSIT_LAYER_ID = "openmapx-transit-layer";
const TRANSIT_LAYER_HINTS = [
  /rail/i,
  /transit/i,
  /tram/i,
  /subway/i,
  /bus/i,
  /transport/i,
] as const;

// MOTIS operated-route network drawn on top of the basemap transit lines. The
// basemap layer is the cheap global base (OSM infrastructure); this enhancement
// shows the actually-operated routes from ingested feeds, but only where we have
// coverage and only when zoomed in (to bound the query + result size).
const MOTIS_SOURCE_ID = "openmapx-transit-motis-source";
const MOTIS_LINE_ID = "openmapx-transit-motis-line";
const MOTIS_MIN_ZOOM = 11;
const MOTIS_FETCH_DEBOUNCE_MS = 350;

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export function TransitLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const showTransit = useTransitStore((s) => s.panelOpen && s.layerVisible);
  useLayerReanchor(TRANSIT_LAYER_ID, showTransit);

  // Runtime publisher credit carried by the MOTIS routes envelope. The manifest
  // declares no static dataSources (the operated network comes from whatever
  // feeds back the local/cloud MOTIS instance), so the only correct credit is
  // the per-response `envelope.attributions`. Register it on the on-map strip
  // while the operated routes are drawn.
  const [routeAttributions, setRouteAttributions] = useState<Attribution[]>([]);
  useMapAttributions("overlay-transit:routes", showTransit ? routeAttributions : []);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncLayer = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", syncLayer);
        return;
      }

      if (showTransit && !map.getLayer(TRANSIT_LAYER_ID)) {
        const reference = findVectorLineReference(map, TRANSIT_LAYER_HINTS);
        if (reference) {
          const beforeLayerId = getFirstSymbolLayerId(map);
          map.addLayer(
            {
              id: TRANSIT_LAYER_ID,
              type: "line",
              source: reference.source,
              "source-layer": reference.sourceLayer,
              filter: ["in", "class", "transit", "rail", "subway", "tram", "bus", "ferry", "train"],
              paint: {
                "line-color": [
                  "match",
                  ["get", "class"],
                  "subway",
                  PRIMARY_BLUE_HEX,
                  "tram",
                  "#0F9D58",
                  "rail",
                  "#5F6368",
                  "bus",
                  "#F29900",
                  "ferry",
                  "#00ACC1",
                  "#34A853",
                ],
                "line-opacity": 0.95,
                "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.9, 10, 1.8, 14, 3],
              },
              layout: {
                "line-cap": "round",
                "line-join": "round",
              },
            },
            beforeLayerId,
          );
        }
      }

      if (showTransit) {
        moveLayerBeforeFirstSymbol(map, TRANSIT_LAYER_ID);
      }

      setLayerVisibility(map, TRANSIT_LAYER_ID, showTransit);
    };

    syncLayer();
    map.on("styledata", syncLayer);
    return () => {
      map.off("styledata", syncLayer);
    };
  }, [mapReady, mapRef, styleVersion, showTransit]);

  // MOTIS operated-route network: a viewport-driven GeoJSON line layer fetched
  // from /routes?bbox, layered above the basemap transit lines. Active only when
  // the overlay is on and zoomed past MOTIS_MIN_ZOOM.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let requestSeq = 0;

    const ensureLayer = () => {
      if (!map.isStyleLoaded() || map.getSource(MOTIS_SOURCE_ID)) return;
      map.addSource(MOTIS_SOURCE_ID, { type: "geojson", data: EMPTY_FC });
      map.addLayer(
        {
          id: MOTIS_LINE_ID,
          type: "line",
          source: MOTIS_SOURCE_ID,
          paint: {
            "line-color": ["get", "color"],
            "line-opacity": 0.9,
            "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.5, 14, 3, 17, 5],
          },
          layout: { "line-cap": "round", "line-join": "round" },
        },
        getFirstSymbolLayerId(map),
      );
    };

    const clearData = () => {
      const src = map.getSource(MOTIS_SOURCE_ID) as GeoJSONSource | undefined;
      src?.setData(EMPTY_FC);
      setRouteAttributions([]);
    };

    const fetchNetwork = async () => {
      if (disposed || !showTransit) return;
      if (map.getZoom() < MOTIS_MIN_ZOOM) {
        clearData();
        return;
      }
      const b = map.getBounds();
      const seq = ++requestSeq;
      try {
        const env = await apiClient.get<MobilityEnvelope<TransitRoute[]>>(
          API_ENDPOINTS.transitRoutes,
          {
            sw_lat: String(b.getSouth()),
            sw_lng: String(b.getWest()),
            ne_lat: String(b.getNorth()),
            ne_lng: String(b.getEast()),
          },
        );
        // Ignore stale responses (user kept panning) and post-unmount results.
        if (disposed || seq !== requestSeq) return;
        const src = map.getSource(MOTIS_SOURCE_ID) as GeoJSONSource | undefined;
        if (!src) return;
        const features: GeoJSON.Feature[] = (env.data ?? [])
          .filter((r) => r.geometry)
          .map((r) => ({
            type: "Feature",
            properties: { color: routeColor(r, "#34A853"), routeId: r.id },
            geometry: r.geometry as GeoJSON.Geometry,
          }));
        src.setData({ type: "FeatureCollection", features });
        // Credit the feed publishers for the geometry now on screen; clear when
        // nothing was drawn so the strip doesn't credit feeds with no visible data.
        setRouteAttributions(features.length > 0 ? (env.attributions ?? []) : []);
      } catch {
        // Soft-fail: leave the basemap transit lines in place.
      }
    };

    const scheduleFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchNetwork, MOTIS_FETCH_DEBOUNCE_MS);
    };

    const onMoveEnd = () => {
      if (showTransit) scheduleFetch();
    };

    if (showTransit) {
      ensureLayer();
      setLayerVisibility(map, MOTIS_LINE_ID, true);
      scheduleFetch();
      map.on("moveend", onMoveEnd);
      map.on("styledata", ensureLayer);
    } else {
      setLayerVisibility(map, MOTIS_LINE_ID, false);
      clearData();
    }

    return () => {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      map.off("moveend", onMoveEnd);
      map.off("styledata", ensureLayer);
    };
  }, [mapReady, mapRef, styleVersion, showTransit]);

  return null;
}
