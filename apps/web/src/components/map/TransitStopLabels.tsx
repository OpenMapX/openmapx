"use client";

import { useColorScheme } from "@mui/material/styles";
import type { MapGeoJSONFeature, MapMovementEvent, MapSourceDataEvent } from "maplibre-gl";
import { useLocale } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import {
  STOP_LABEL_LAYER_ID,
  STOP_LABEL_SOURCE_ID,
  type StationPoint,
  type StopLabelFeature,
  type StopPoint,
  stopLabelFeatures,
  stopLabelLayer,
} from "./stopLabelPoints";

const BASEMAP_SOURCE_ID = "openmaptiles";
const LABEL_MIN_ZOOM = 16;
const REFRESH_INTERVAL_MS = 250;
const STATION_SUBCLASSES = new Set(["station", "halt", "subway"]);

function displayedName(properties: MapGeoJSONFeature["properties"], locale: string) {
  const localized = properties[`name:${locale}`];
  if (typeof localized === "string" && localized) return localized;
  return typeof properties.name === "string" && properties.name ? properties.name : null;
}

function onGround(properties: MapGeoJSONFeature["properties"]) {
  return properties.level === undefined || properties.level === 0;
}

function isStop(poiClass: unknown, subclass: unknown) {
  return (poiClass === "bus" && subclass !== "bus_station") || subclass === "tram_stop";
}

/**
 * Names each bus and tram stop once, however many platforms carry its name.
 * The bundled styles draw stops as bare icons; this reads those stops from the
 * basemap tiles in view and labels one point per stop. Styles whose tiles are
 * not OpenMapTiles have no such source, and the layer stays empty.
 */
export function TransitStopLabels() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const locale = useLocale();
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === "system" ? systemMode : mode) === "dark";
  const [features, setFeatures] = useState<StopLabelFeature[]>([]);

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let frame = 0;
    let published = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastUpdate = -Infinity;
    let visible = map.getZoom() >= LABEL_MIN_ZOOM;

    const clear = () => {
      if (published !== "[]") {
        published = "[]";
        setFeatures([]);
      }
    };

    const update = () => {
      frame = 0;
      lastUpdate = Date.now();
      if (map.getZoom() < LABEL_MIN_ZOOM || !map.getSource(BASEMAP_SOURCE_ID)) {
        clear();
        return;
      }
      const stops: StopPoint[] = [];
      const stations: StationPoint[] = [];
      for (const feature of map.querySourceFeatures(BASEMAP_SOURCE_ID, { sourceLayer: "poi" })) {
        if (feature.geometry.type !== "Point") continue;
        const { class: poiClass, subclass, rank } = feature.properties;
        const name = displayedName(feature.properties, locale);
        if (!name) continue;
        const coordinates = feature.geometry.coordinates as [number, number];
        if (isStop(poiClass, subclass)) {
          // The map draws only ground-level stops; a stop on another level has no icon to name.
          if (!onGround(feature.properties)) continue;
          stops.push({
            id: typeof feature.id === "number" ? feature.id : undefined,
            name,
            poiClass: String(poiClass),
            subclass: typeof subclass === "string" ? subclass : undefined,
            rank: typeof rank === "number" ? rank : 9999,
            coordinates,
          });
        } else if (poiClass === "railway" && STATION_SUBCLASSES.has(String(subclass))) {
          // An underground station still names the stops above it.
          stations.push({ name, coordinates });
        }
      }
      const next = stopLabelFeatures(stops, stations);
      const serialized = JSON.stringify(next);
      if (serialized === published) return;
      published = serialized;
      setFeatures(next);
    };
    const schedule = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (!frame) frame = requestAnimationFrame(update);
    };
    const scheduleBounded = () => {
      if (frame || timer !== undefined || map.getZoom() < LABEL_MIN_ZOOM) return;
      const delay = Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - lastUpdate));
      if (delay === 0) schedule();
      else {
        timer = setTimeout(() => {
          timer = undefined;
          schedule();
        }, delay);
      }
    };
    const onZoom = () => {
      const nextVisible = map.getZoom() >= LABEL_MIN_ZOOM;
      if (nextVisible === visible) return false;
      visible = nextVisible;
      schedule();
      return true;
    };
    const onMoveEnd = (event: MapMovementEvent & { programmatic?: boolean }) => {
      if (onZoom() || !visible) return;
      // Navigation jumpTo runs every frame, including when it reveals cached
      // tiles without a source event. Keep a bounded trailing refresh for it.
      if (event?.programmatic) scheduleBounded();
      else schedule();
    };
    const onSourceData = (event: MapSourceDataEvent) => {
      if (event.sourceId !== BASEMAP_SOURCE_ID) return;
      // idle/visibility are source lifecycle notifications, not tile arrivals.
      // Tile data can omit sourceDataType and arrive before isSourceLoaded.
      if (
        event.sourceDataType === "content" ||
        event.sourceDataType === "metadata" ||
        event.coord
      ) {
        scheduleBounded();
      }
    };

    schedule();
    map.on("moveend", onMoveEnd);
    map.on("zoom", onZoom);
    map.on("sourcedata", onSourceData);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      map.off("moveend", onMoveEnd);
      map.off("zoom", onZoom);
      map.off("sourcedata", onSourceData);
    };
  }, [mapRef, mapReady, styleVersion, locale]);

  const group = useMemo<MapLayerGroup | null>(
    () =>
      features.length === 0
        ? null
        : {
            sources: {
              [STOP_LABEL_SOURCE_ID]: {
                type: "geojson",
                data: { type: "FeatureCollection", features },
              },
            },
            layers: [{ ...stopLabelLayer(dark), id: STOP_LABEL_LAYER_ID, slot: "overlay-markers" }],
          },
    [features, dark],
  );
  useMapLayerGroup(group);

  return null;
}
