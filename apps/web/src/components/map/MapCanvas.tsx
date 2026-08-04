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
  currentOfflinePackageResolver,
  ensureOfflinePackageRuntime,
  registerOfflinePmtilesProtocol,
  setOfflinePackageActive,
} from "@/lib/offlineAreas";

type MapLibreRuntime = typeof import("maplibre-gl");
type ViewportStyle = {
  offlinePackageId: string | null;
  style: Record<string, unknown>;
};

async function loadStyleForViewport(
  env: ReturnType<typeof useEnv>,
  variant: MapStyleVariant,
  mapStyle: string,
  center: LngLat,
  maplibre: MapLibreRuntime,
): Promise<ViewportStyle> {
  if (env.styleProvider === "openmapx" && typeof navigator !== "undefined" && !navigator.onLine) {
    const resolver = await ensureOfflinePackageRuntime();
    const packageRecord = resolver?.packageForCoordinate(center);
    if (resolver && packageRecord) {
      registerOfflinePmtilesProtocol(maplibre, resolver);
      return {
        offlinePackageId: packageRecord.id,
        style: await loadOpenMapXStyle(env, variant, {
          packageId: packageRecord.id,
          manifest: packageRecord.manifest,
        }),
      };
    }
  }

  return {
    offlinePackageId: null,
    style:
      env.styleProvider === "openmapx"
        ? await loadOpenMapXStyle(env, variant)
        : await loadMaptilerStyle(mapStyle, env),
  };
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
  const { setCenter, setZoom, setBearing, setPitch, setUserLocation } = useMapStore();
  const activeOfflinePackageIdRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mapStyle intentionally excluded — style changes handled by the style-swap effect below
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
      let viewportStyle: ViewportStyle | undefined;
      try {
        maplibreRuntime = await import("maplibre-gl");
        if (destroyed || !containerRef.current) return;
        const maplibregl = maplibreRuntime as unknown as MapLibreRuntime;
        viewportStyle = await loadStyleForViewport(
          env,
          variant,
          mapStyle,
          initialCenter,
          maplibregl,
        );
      } catch (err) {
        console.error("Failed to initialize map", err);
        return;
      }
      if (!maplibreRuntime || !viewportStyle) return;
      const maplibregl = maplibreRuntime as unknown as typeof import("maplibre-gl");

      if (destroyed || !containerRef.current) return;
      activeOfflinePackageIdRef.current = viewportStyle.offlinePackageId;
      setOfflinePackageActive(viewportStyle.offlinePackageId !== null);

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

      let viewportStyleRequest = 0;
      let pendingViewportStyle: { force: boolean; offlinePackageId: string | null } | undefined;
      const applyStyleForViewport = (
        center: LngLat,
        force: boolean,
        reason: string,
        expectedOfflinePackageId: string | null,
      ) => {
        const request = ++viewportStyleRequest;
        pendingViewportStyle = { force, offlinePackageId: expectedOfflinePackageId };
        void loadStyleForViewport(env, variant, mapStyle, center, maplibregl)
          .then((next) => {
            if (destroyed || request !== viewportStyleRequest) return;
            if (!force && next.offlinePackageId === activeOfflinePackageIdRef.current) return;
            activeOfflinePackageIdRef.current = next.offlinePackageId;
            setOfflinePackageActive(next.offlinePackageId !== null);
            map.setStyle(next.style as maplibregl.StyleSpecification);
          })
          .catch((err) => {
            console.warn(`Unable to switch map style for ${reason}`, err);
          })
          .finally(() => {
            if (request === viewportStyleRequest) pendingViewportStyle = undefined;
          });
      };

      map.on("moveend", (e) => {
        const c = map.getCenter();
        const center: LngLat = [c.lng, c.lat];
        if (
          env.styleProvider === "openmapx" &&
          typeof navigator !== "undefined" &&
          !navigator.onLine
        ) {
          const nextPackageId =
            currentOfflinePackageResolver()?.packageForCoordinate(center)?.id ?? null;
          if (
            nextPackageId !== activeOfflinePackageIdRef.current &&
            nextPackageId !== pendingViewportStyle?.offlinePackageId
          ) {
            applyStyleForViewport(center, false, "offline coverage change", nextPackageId);
          } else if (
            nextPackageId === activeOfflinePackageIdRef.current &&
            pendingViewportStyle &&
            !pendingViewportStyle.force
          ) {
            // The camera returned before an earlier async style load completed.
            // Invalidate it so stale coverage cannot win the race.
            viewportStyleRequest += 1;
            pendingViewportStyle = undefined;
          }
        }

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
        const current = map.getCenter();
        const center: LngLat = [current.lng, current.lat];
        const expectedOfflinePackageId =
          env.styleProvider === "openmapx" && !navigator.onLine
            ? (currentOfflinePackageResolver()?.packageForCoordinate(center)?.id ?? null)
            : null;
        applyStyleForViewport(center, true, "connectivity change", expectedOfflinePackageId);
      };
      window.addEventListener("online", reloadForConnectivity);
      window.addEventListener("offline", reloadForConnectivity);
      cleanupConnectivity = () => {
        window.removeEventListener("online", reloadForConnectivity);
        window.removeEventListener("offline", reloadForConnectivity);
      };
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
      activeOfflinePackageIdRef.current = null;
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

    const center = map.getCenter();
    Promise.all([import("maplibre-gl"), Promise.resolve([center.lng, center.lat] as LngLat)])
      .then(([module, currentCenter]) =>
        loadStyleForViewport(env, variant, mapStyle, currentCenter, module as MapLibreRuntime),
      )
      .then((s) => {
        // The persistent `style.load` listener registered at map creation bumps
        // styleVersion once the new style lands.
        activeOfflinePackageIdRef.current = s.offlinePackageId;
        setOfflinePackageActive(s.offlinePackageId !== null);
        map.setStyle(s.style as maplibregl.StyleSpecification);
      })
      .catch((err) => {
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
