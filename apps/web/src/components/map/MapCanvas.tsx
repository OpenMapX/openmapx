"use client";

import { useColorScheme } from "@mui/material/styles";
import type { LngLat } from "@openmapx/core";
import { useMapStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useLocale } from "next-intl";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { loadOpenMapXStyle, maptilerStyleUrl } from "@/lib/map";
import { useMapAttributionExpandedObserver } from "@/lib/mapAttributionExpanded";

export function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { mapRef, mapReady, notifyMapReady, notifyStyleReload } = useMap();
  const env = useEnv();
  const locale = useLocale();
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = mode === "system" ? systemMode : mode;
  const mapStyle = resolvedMode === "dark" ? "streets-v2-dark" : "bright-v2";
  const { setCenter, setZoom, setBearing, setPitch, setUserLocation } = useMapStore();
  useMapAttributionExpandedObserver();

  // biome-ignore lint/correctness/useExhaustiveDependencies: mapStyle intentionally excluded — style changes handled by the style-swap effect below
  useEffect(() => {
    if (!containerRef.current) return;

    // Read initial viewport values once at mount — not reactive dependencies.
    // Adding center/zoom/bearing/pitch to the dep array would cause the map to
    // be destroyed and re-created every time the user pans or zooms.
    const { center, zoom, bearing, pitch } = useMapStore.getState();

    let destroyed = false;

    const initMap = async (initialCenter: LngLat, initialZoom: number) => {
      setCenter(initialCenter);
      setZoom(initialZoom);
      const maplibregl = (await import("maplibre-gl")).default;
      if (destroyed || !containerRef.current) return;

      const style =
        env.styleProvider === "openmapx"
          ? await loadOpenMapXStyle(env)
          : maptilerStyleUrl(mapStyle, env);

      if (destroyed || !containerRef.current) return;

      const map = new maplibregl.Map({
        container: containerRef.current,
        style: style as string | maplibregl.StyleSpecification,
        center: initialCenter,
        zoom: initialZoom,
        bearing,
        pitch,
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
      });

      // `compact` left undefined → MapLibre auto-collapses to an "i" button
      // below 640px viewport width, which keeps the attribution from wrapping
      // across the footer/legal links on mobile. The control's <details>
      // element renders open by default in compact mode, so force it closed
      // once after mounting.
      map.addControl(new maplibregl.AttributionControl(), "bottom-right");
      const attrib = map.getContainer().querySelector(".maplibregl-ctrl-attrib");
      if (attrib instanceof HTMLDetailsElement) attrib.open = false;
      attrib?.classList.remove("maplibregl-compact-show");

      map.on("moveend", () => {
        const c = map.getCenter();
        setCenter([c.lng, c.lat]);
        setZoom(map.getZoom());
        setBearing(map.getBearing());
        setPitch(map.getPitch());
      });

      mapRef.current = map;
      notifyMapReady();
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
  }, [env, mapRef, notifyMapReady, setBearing, setCenter, setPitch, setUserLocation, setZoom]);

  // Swap map tile style when dark/light mode changes
  const initialStyleRef = useRef(mapStyle);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // Skip on first render — the map was already created with this style
    if (mapStyle === initialStyleRef.current) return;
    initialStyleRef.current = mapStyle;

    if (env.styleProvider === "openmapx") {
      loadOpenMapXStyle(env).then((s) => {
        map.setStyle(s as maplibregl.StyleSpecification);
        map.once("style.load", () => notifyStyleReload());
      });
    } else {
      const newUrl = maptilerStyleUrl(mapStyle, env);
      map.setStyle(newUrl);
      map.once("style.load", () => notifyStyleReload());
    }
  }, [env, mapStyle, mapRef, mapReady, notifyStyleReload]);

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
