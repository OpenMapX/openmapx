"use client";

import { useColorScheme } from "@mui/material/styles";
import type { LngLat } from "@openmapx/core";
import { useMapStore, useNavigationStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useLocale } from "next-intl";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { loadMaptilerStyle, loadOpenMapXStyle, type MapStyleVariant } from "@/lib/map";

export function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { mapRef, mapReady, notifyMapReady, notifyStyleReload } = useMap();
  const env = useEnv();
  const locale = useLocale();
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = mode === "system" ? systemMode : mode;
  const mapStyle = resolvedMode === "dark" ? "streets-v2-dark" : "bright-v2";
  const variant: MapStyleVariant = resolvedMode === "dark" ? "dark" : "light";
  const { setCenter, setZoom, setBearing, setPitch, setUserLocation } = useMapStore();

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
      // The maplibre-gl type definitions don't expose a typed `default` field
      // on the module namespace, so we widen the runtime binding to `unknown`
      // until inside the guard and then trust the top-level type-only import
      // (`import type maplibregl`) for member typing.
      let maplibreRuntime: unknown;
      let style: Record<string, unknown> | string | undefined;
      try {
        maplibreRuntime = (await import("maplibre-gl")).default;
        if (destroyed || !containerRef.current) return;
        style =
          env.styleProvider === "openmapx"
            ? await loadOpenMapXStyle(env, variant)
            : await loadMaptilerStyle(mapStyle, env);
      } catch (err) {
        console.error("Failed to initialize map", err);
        return;
      }
      if (!maplibreRuntime || !style) return;
      const maplibregl = maplibreRuntime as unknown as typeof import("maplibre-gl");

      if (destroyed || !containerRef.current) return;

      // MapLibre's built-in AttributionControl handles the bottom-right
      // attribution strip. With the default options it auto-collapses to the
      // ⓘ toggle on narrow viewports and expands on desktop. Per-layer
      // attribution is contributed via the `useMapAttributions` hook (see
      // apps/web/src/lib/useMapAttributions.ts).
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: style as string | maplibregl.StyleSpecification,
        center: initialCenter,
        zoom: initialZoom,
        bearing,
        pitch,
        canvasContextAttributes: { antialias: true },
      });

      map.on("moveend", (e) => {
        // The navigation follow camera drives the map with a programmatic
        // jumpTo every animation frame; skip those so we don't write to the
        // store 60×/s while navigating. User gestures and other programmatic
        // moves (flyTo, deep links) still persist as before.
        if (
          (e as { programmatic?: boolean })?.programmatic &&
          useNavigationStore.getState().status !== "idle"
        ) {
          return;
        }
        const c = map.getCenter();
        setCenter([c.lng, c.lat]);
        setZoom(map.getZoom());
        setBearing(map.getBearing());
        setPitch(map.getPitch());
      });

      mapRef.current = map;
      // Defer `mapReady` until the style finishes loading so attribution
      // hooks (`useMapAttributions`) don't have to fall through their
      // `!isStyleLoaded()` retry path on first paint, which left the strip
      // showing only style-baked credits until `idle` fired.
      if (map.isStyleLoaded()) {
        notifyMapReady();
      } else {
        map.once("style.load", () => {
          if (!destroyed) notifyMapReady();
        });
      }
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

    const loadStyle =
      env.styleProvider === "openmapx"
        ? loadOpenMapXStyle(env, variant)
        : loadMaptilerStyle(mapStyle, env);
    loadStyle
      .then((s) => {
        map.setStyle(s as maplibregl.StyleSpecification);
        map.once("style.load", () => notifyStyleReload());
      })
      .catch((err) => {
        console.error("Failed to swap map style", err);
      });
  }, [env, mapStyle, variant, mapRef, mapReady, notifyStyleReload]);

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
