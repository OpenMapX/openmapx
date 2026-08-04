"use client";

import { useColorScheme } from "@mui/material/styles";
import type { LngLat } from "@openmapx/core";
import { useMapStore, useNavigationStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useLocale } from "next-intl";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useMap } from "@/lib/MapContext";
import { loadMaptilerStyle, loadOpenMapXStyle, type MapStyleVariant } from "@/lib/map";
import {
  ensureOfflinePackageRuntime,
  OFFLINE_PACKAGE_CHANGED_EVENT,
  registerOfflinePmtilesProtocol,
  selectOnlineFirstOpenMapXStyle,
  setOfflinePackageActive,
} from "@/lib/offlineAreas";

type MapLibreRuntime = typeof import("maplibre-gl");

async function loadStyleForViewport(
  env: ReturnType<typeof useEnv>,
  variant: MapStyleVariant,
  mapStyle: string,
  maplibre: MapLibreRuntime,
): Promise<{ offline: boolean; style: Record<string, unknown> }> {
  if (env.styleProvider !== "openmapx") {
    return { offline: false, style: await loadMaptilerStyle(mapStyle, env) };
  }

  const [configuredStyle, resolver] = await Promise.all([
    loadOpenMapXStyle(env, variant),
    ensureOfflinePackageRuntime(),
  ]);
  const packageRecords =
    resolver
      ?.compatiblePackageIds()
      .map((packageId) => resolver.get(packageId))
      .filter((record) => record !== undefined) ?? [];
  const selected = await selectOnlineFirstOpenMapXStyle(
    configuredStyle,
    packageRecords.map((record) => ({ packageId: record.id, manifest: record.manifest })),
    { apiBaseUrl: env.apiUrl },
  );
  if (selected.offline && resolver) registerOfflinePmtilesProtocol(maplibre, resolver);
  return selected;
}

export function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { mapRef, mapReady, notifyMapReady, notifyStyleReload } = useMap();
  const env = useEnv();
  const locale = useLocale();
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = mode === "system" ? systemMode : mode;
  const mapStyle = resolvedMode === "dark" ? "streets-v2-dark" : "bright-v2";
  const variant: MapStyleVariant = resolvedMode === "dark" ? "dark" : "light";
  const currentStyleRef = useRef({ mapStyle, variant });
  currentStyleRef.current = { mapStyle, variant };
  const styleRequestRef = useRef(0);
  const { setCenter, setZoom, setBearing, setPitch, setUserLocation } = useMapStore();

  useEffect(() => {
    if (!containerRef.current) return;

    // Read initial viewport values once at mount — not reactive dependencies.
    // Adding center/zoom/bearing/pitch to the dep array would cause the map to
    // be destroyed and re-created every time the user pans or zooms.
    const { center, zoom, bearing, pitch } = useMapStore.getState();

    let destroyed = false;
    let cleanupConnectivity: (() => void) | undefined;

    const initMap = async (initialCenter: LngLat, initialZoom: number) => {
      setCenter(initialCenter);
      setZoom(initialZoom);
      // Keep the dynamically loaded module as a namespace: MapLibre 6 no longer
      // exposes a synthetic default export.
      let maplibreRuntime: unknown;
      let viewportStyle: Awaited<ReturnType<typeof loadStyleForViewport>> | undefined;
      try {
        maplibreRuntime = await import("maplibre-gl");
        if (destroyed || !containerRef.current) return;
        const maplibregl = maplibreRuntime as unknown as MapLibreRuntime;
        const currentStyle = currentStyleRef.current;
        viewportStyle = await loadStyleForViewport(
          env,
          currentStyle.variant,
          currentStyle.mapStyle,
          maplibregl,
        );
      } catch (err) {
        console.error("Failed to initialize map", err);
        return;
      }
      if (!maplibreRuntime || !viewportStyle) return;
      const maplibregl = maplibreRuntime as unknown as typeof import("maplibre-gl");

      if (destroyed || !containerRef.current) return;
      setOfflinePackageActive(viewportStyle.offline);

      // MapLibre's built-in AttributionControl is disabled: it collapses to a
      // ⓘ toggle on narrow viewports and lives in its own DOM subtree, so it
      // can't share a bar with the legal links. The credits are rendered by
      // `<MapFooter>` instead, fed by the `useMapAttributions` hook (see
      // apps/web/src/lib/useMapAttributions.ts) via the attribution registry.
      // Every style we load has its source-level `attribution` stripped (see
      // lib/map.ts), so no credit is lost by turning the control off.
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: viewportStyle.style as maplibregl.StyleSpecification,
        center: initialCenter,
        zoom: initialZoom,
        bearing,
        pitch,
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
      });

      try {
        const applyStyleForViewport = (reason: string) => {
          const request = ++styleRequestRef.current;
          const currentStyle = currentStyleRef.current;
          void loadStyleForViewport(env, currentStyle.variant, currentStyle.mapStyle, maplibregl)
            .then((next) => {
              if (destroyed || request !== styleRequestRef.current) return;
              setOfflinePackageActive(next.offline);
              map.setStyle(next.style as maplibregl.StyleSpecification);
            })
            .catch((err) => {
              console.warn(`Unable to switch map style for ${reason}`, err);
            });
        };

        map.on("moveend", (e) => {
          const c = map.getCenter();
          const center: LngLat = [c.lng, c.lat];
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
          setCenter(center);
          setZoom(map.getZoom());
          setBearing(map.getBearing());
          setPitch(map.getPitch());
        });

        mapRef.current = map;

        // Every later style load — a dark/light swap, a basemap switch — bumps the
        // counter layers rebuild on. Registering it once here rather than per swap
        // is what makes that unconditional: a `once` attached after `setStyle` is
        // called can miss a style that resolves from cache, and the counter then
        // never moves for the rest of the session.
        map.on("style.load", () => {
          if (!destroyed) notifyStyleReload();
        });

        const reloadForConnectivity = () => {
          if (destroyed) return;
          applyStyleForViewport("connectivity change");
        };
        const reloadForPackages = () => {
          void ensureOfflinePackageRuntime().then(async (resolver) => {
            await resolver?.refresh();
            reloadForConnectivity();
          });
        };
        window.addEventListener("online", reloadForConnectivity);
        window.addEventListener("offline", reloadForConnectivity);
        window.addEventListener(OFFLINE_PACKAGE_CHANGED_EVENT, reloadForPackages);
        cleanupConnectivity = () => {
          window.removeEventListener("online", reloadForConnectivity);
          window.removeEventListener("offline", reloadForConnectivity);
          window.removeEventListener(OFFLINE_PACKAGE_CHANGED_EVENT, reloadForPackages);
        };

        // Publish readiness only after every synchronous setup step succeeds.
        // Otherwise a later setup exception can leave consumers observing a
        // "ready" context whose map has already been removed.
        if (map.isStyleLoaded()) {
          notifyMapReady();
        } else {
          map.once("style.load", () => {
            if (!destroyed) notifyMapReady();
          });
        }
        return map;
      } catch (error) {
        cleanupConnectivity?.();
        cleanupConnectivity = undefined;
        if (mapRef.current === map) mapRef.current = null;
        map.remove();
        throw error;
      }
    };

    // Render the saved viewport immediately. A granted geolocation permission
    // must not become a startup dependency: browsers are allowed to leave
    // getCurrentPosition pending indefinitely while a provider is unavailable.
    const mapInitialization = initMap(center, zoom).catch((err) => {
      console.error("Failed to initialize map", err);
      return undefined;
    });

    // If geolocation permission is already granted, move to the user's location
    // (zoom 14) and show the marker when it arrives — without prompting.
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
                void mapInitialization.then((map) => {
                  if (destroyed || !map) return;
                  setUserLocation(lngLat);
                  map.jumpTo({ center: lngLat, zoom: 14 }, { programmatic: true });
                });
              },
              () => undefined,
            );
          }
        })
        .catch(() => undefined);
    }

    return () => {
      destroyed = true;
      styleRequestRef.current++;
      setOfflinePackageActive(false);
      cleanupConnectivity?.();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [
    env,
    mapRef,
    notifyMapReady,
    notifyStyleReload,
    setBearing,
    setCenter,
    setPitch,
    setUserLocation,
    setZoom,
  ]);

  // Swap map tile style when dark/light mode changes
  const initialStyleRef = useRef(mapStyle);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // Skip on first render — the map was already created with this style
    if (mapStyle === initialStyleRef.current) return;
    initialStyleRef.current = mapStyle;

    const request = ++styleRequestRef.current;
    import("maplibre-gl")
      .then((module) => loadStyleForViewport(env, variant, mapStyle, module as MapLibreRuntime))
      .then((s) => {
        if (request !== styleRequestRef.current || mapRef.current !== map) return;
        // The persistent `style.load` listener registered at map creation bumps
        // styleVersion once the new style lands.
        setOfflinePackageActive(s.offline);
        map.setStyle(s.style as maplibregl.StyleSpecification);
      })
      .catch((err) => {
        if (request !== styleRequestRef.current) return;
        console.error("Failed to swap map style", err);
      });
  }, [env, mapStyle, variant, mapRef, mapReady]);

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
