"use client";

import type { LngLat } from "@openmapx/core";
import { useMapStore } from "@openmapx/core";
import { useLocale } from "next-intl";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";
import { maptilerStyleUrl } from "@/lib/map";

export function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { mapRef, mapReady, notifyMapReady } = useMap();
  const locale = useLocale();
  const { setCenter, setZoom, setBearing, setPitch, setUserLocation } = useMapStore();

  useEffect(() => {
    if (!containerRef.current) return;

    // Read initial viewport values once at mount — not reactive dependencies.
    // Adding center/zoom/bearing/pitch to the dep array would cause the map to
    // be destroyed and re-created every time the user pans or zooms.
    const { center, zoom, bearing, pitch } = useMapStore.getState();

    const styleUrl = maptilerStyleUrl();
    let destroyed = false;

    const initMap = (initialCenter: LngLat, initialZoom: number) => {
      import("maplibre-gl").then(({ default: maplibregl }) => {
        if (destroyed || !containerRef.current) return;

        const map = new maplibregl.Map({
          container: containerRef.current,
          style: styleUrl,
          center: initialCenter,
          zoom: initialZoom,
          bearing,
          pitch,
          attributionControl: false,
          canvasContextAttributes: { antialias: true },
        });

        map.addControl(new maplibregl.AttributionControl({ compact: false }), "bottom-right");

        map.on("moveend", () => {
          const c = map.getCenter();
          setCenter([c.lng, c.lat]);
          setZoom(map.getZoom());
          setBearing(map.getBearing());
          setPitch(map.getPitch());
        });

        mapRef.current = map;
        notifyMapReady();
      });
    };

    // If geolocation permission is already granted, initialize the map centered
    // on the user's location (zoom 14) and show the marker — without prompting.
    if (navigator.permissions && navigator.geolocation) {
      navigator.permissions
        .query({ name: "geolocation" })
        .then((result) => {
          if (destroyed) return;
          if (result.state === "granted") {
            navigator.geolocation.getCurrentPosition(
              (pos) => {
                if (destroyed) return;
                const lngLat: LngLat = [pos.coords.longitude, pos.coords.latitude];
                setUserLocation(lngLat);
                initMap(lngLat, 14);
              },
              () => {
                if (!destroyed) initMap(center, zoom);
              },
            );
          } else {
            initMap(center, zoom);
          }
        })
        .catch(() => {
          if (!destroyed) initMap(center, zoom);
        });
    } else {
      initMap(center, zoom);
    }

    return () => {
      destroyed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [mapRef, notifyMapReady, setBearing, setCenter, setPitch, setUserLocation, setZoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update map label language when locale changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const setLabels = () => {
      const style = map.getStyle();
      if (!style?.layers) return;
      for (const layer of style.layers) {
        if (layer.type !== "symbol") continue;
        const tf = layer.layout?.["text-field"];
        if (!tf) continue;
        // Only override layers whose text-field actually references "name".
        // Skip road shields, route refs, house numbers, etc.
        const serialized = JSON.stringify(tf);
        if (!serialized.includes("name")) continue;
        map.setLayoutProperty(layer.id, "text-field", [
          "coalesce",
          ["get", `name:${locale}`],
          ["get", "name"],
        ]);
      }
    };

    setLabels();
    map.on("styledata", setLabels);
    return () => {
      map.off("styledata", setLabels);
    };
  }, [locale, mapRef, mapReady]);

  // Outer div owns the absolute positioning.
  // MapLibre gets the inner div so its .maplibregl-map class (position: relative)
  // doesn't clobber inset-0, which only works on absolutely-positioned elements.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
