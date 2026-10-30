"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import { useColorScheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import type { LngLat } from "@openmapx/core";
import {
  isBuildingStyleLayer,
  readLastMapView,
  useMapStore,
  useNavigationStore,
  useSettingsStore,
  writeLastMapView,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import {
  installedNativeBasemap,
  type NativeBasemapCandidate,
} from "@/integration-api/overlay/nativeBasemap";
import { attributedRasterRequestTransform } from "@/integration-api/overlay/rasterResponseProtocol";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { loadMaptilerStyle, loadOpenMapXStyle, type MapStyleVariant } from "@/lib/map";
import { initializeMapClickModes } from "@/lib/mapClickModes";
import { MAP_FOOTER_OBSTRUCTION_ID, useMapFooterBox } from "@/lib/mapFooterCenter";
import { loadMapLibreRuntime, type MapLibreRuntime } from "@/lib/maplibreRuntime";
import { useMapObstructionExtent, useMapObstructionInsets } from "@/lib/mapObstructions";
import { useForegroundLocation } from "@/lib/mobile/useForegroundLocation";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { useMobilePanelClearance, useWindowHeight, useWindowWidth } from "@/lib/mobilePanelHeight";
import { captureNativeBasemapRequest } from "@/lib/nativeBasemapAcquisition";
import {
  ensureOfflinePackageRuntime,
  OFFLINE_PACKAGE_CHANGED_EVENT,
  registerOfflinePmtilesProtocol,
  selectOnlineFirstOpenMapXStyle,
  setOfflinePackageActive,
} from "@/lib/offlineAreas";
import { planAboveFooter, sheetFollowSx, useSheetFollowTrack } from "@/lib/sheetFollow";
import { localizeMapLabels } from "./localizeTextField";

/** The main map uses its camera-aware 3D layer instead of basemap extrusions. */
function withoutNativeBuildingExtrusions(style: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(style.layers)) return style;
  const layers = style.layers.filter((layer) => {
    if (!layer || typeof layer !== "object") return true;
    return layer.type !== "fill-extrusion" || !isBuildingStyleLayer(layer);
  });
  return layers.length === style.layers.length ? style : { ...style, layers };
}

async function loadStyleForViewport(
  acquisition: ReturnType<typeof captureNativeBasemapRequest>,
  variant: MapStyleVariant,
  mapStyle: string,
  maplibre: MapLibreRuntime,
): Promise<NativeBasemapCandidate> {
  const { env } = acquisition;
  if (env.styleProvider !== "openmapx") {
    return acquisition.bind(
      withoutNativeBuildingExtrusions(await loadMaptilerStyle(mapStyle, env)),
      false,
    );
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
  return acquisition.bind(withoutNativeBuildingExtrusions(selected.style), selected.offline);
}

export function MapCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { mapRef, mapReady, notifyMapReady, notifyStyleReload } = useMap();
  const env = useEnv();
  const locale = useLocale();
  const t = useTranslations("map");
  const tCommon = useTranslations("common");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [retryKey, setRetryKey] = useState(0);
  const attemptRef = useRef(0);
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = mode === "system" ? systemMode : mode;
  const mapStyle = resolvedMode === "dark" ? "streets-v2-dark" : "bright-v2";
  const variant: MapStyleVariant = resolvedMode === "dark" ? "dark" : "light";
  const currentStyleRef = useRef({ mapStyle, variant });
  currentStyleRef.current = { mapStyle, variant };
  const styleRequestRef = useRef(0);
  const units = useSettingsStore((s) => s.units);
  const unitsRef = useRef(units);
  unitsRef.current = units;
  const scaleRef = useRef<{ map: maplibregl.Map; control: maplibregl.ScaleControl } | null>(null);
  const { setCenter, setZoom, setBearing, setPitch, setUserLocation } = useMapStore();
  const requestFix = useForegroundLocation();
  const { browserAuthority, permission: nativePermission } = useMobileRuntime();
  const locationAuthority = browserAuthority ? "browser" : "native";
  const insets = useMapObstructionInsets();
  const viewportHeight = useWindowHeight();
  const viewportWidth = useWindowWidth();
  const sheetClearance = useMobilePanelClearance(viewportHeight);
  // The live footer and sheet edges rather than `insets.bottom`, which holds a
  // moving sheet's last settled height and would leave the scale behind it.
  const footerExtent = useMapObstructionExtent(MAP_FOOTER_OBSTRUCTION_ID);
  const scaleLeft = 12;
  const scaleBottom = Math.max(102, footerExtent + 12, sheetClearance + 12);
  // While a sheet drives the follow, the scale rides the footer (or, with the
  // footer docked, the sheet edge) on the compositor (see lib/sheetFollow).
  const followTrack = useSheetFollowTrack();
  const footerBox = useMapFooterBox();
  const scaleFollow = followTrack ? planAboveFooter(followTrack, footerBox, 12, 102) : null;
  // Turn-by-turn guidance has no use for a distance scale, and its speed-limit
  // badge sits over the same corner.
  const groundNavigating = useNavigationStore((s) => s.status !== "idle" && s.kind === "ground");
  const scaleVisible =
    !groundNavigating &&
    (viewportHeight === 0 || viewportHeight - insets.top - scaleBottom >= 24) &&
    (viewportWidth === 0 || viewportWidth - scaleLeft - 12 >= 100);

  useEffect(() => {
    if (!containerRef.current) return;
    initializeMapClickModes();

    // Read initial viewport values once at mount — not reactive dependencies.
    // Adding center/zoom/bearing/pitch to the dep array would cause the map to
    // be destroyed and re-created every time the user pans or zooms.
    const { bearing, pitch, ...storeView } = useMapStore.getState();
    // A view the page was opened on (a shared link, a reload) wins; otherwise
    // reopen where the map was last left, unless the user switched that off.
    const linkedView = new URLSearchParams(window.location.search).has("map");
    const lastView = linkedView ? null : readLastMapView();
    const { center, zoom } = lastView ?? storeView;

    const attempt = retryKey;
    let destroyed = false;
    let attemptFailed = false;
    let activeMap: maplibregl.Map | undefined;
    let cleanupConnectivity: (() => void) | undefined;
    const isActive = () => !destroyed && attempt === attemptRef.current;
    const dispose = () => {
      styleRequestRef.current++;
      cleanupConnectivity?.();
      cleanupConnectivity = undefined;
      if (activeMap) {
        if (scaleRef.current?.map === activeMap) {
          activeMap.removeControl(scaleRef.current.control);
          scaleRef.current = null;
        }
        if (mapRef.current === activeMap) mapRef.current = null;
        activeMap.remove();
        activeMap = undefined;
      }
      setOfflinePackageActive(false);
    };
    setStatus("loading");

    const initMap = async (initialCenter: LngLat, initialZoom: number) => {
      setCenter(initialCenter);
      setZoom(initialZoom);
      // Keep the dynamically loaded module as a namespace: MapLibre 6 no longer
      // exposes a synthetic default export.
      const request = ++styleRequestRef.current;
      const acquisition = captureNativeBasemapRequest(env);
      const maplibreRuntime = await loadMapLibreRuntime();
      if (!isActive() || !containerRef.current) return;
      const currentStyle = currentStyleRef.current;
      const viewportStyle = await loadStyleForViewport(
        acquisition,
        currentStyle.variant,
        currentStyle.mapStyle,
        maplibreRuntime as MapLibreRuntime,
      );
      const maplibregl = maplibreRuntime as unknown as typeof import("maplibre-gl");

      if (!isActive() || !containerRef.current) return;
      if (request !== styleRequestRef.current) return;

      // MapLibre's built-in AttributionControl is disabled: it collapses to a
      // ⓘ toggle on narrow viewports and lives in its own DOM subtree, so it
      // can't share a bar with the legal links. The credits are rendered by
      // `<MapFooter>` instead, fed by captured rendered contributions and exact
      // popup/custom owners through integration-api/overlay/mapAttributionStore.
      // Every style we load has its source-level `attribution` stripped (see
      // lib/map.ts), so no credit is lost by turning the control off.
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: viewportStyle.style,
        center: initialCenter,
        zoom: initialZoom,
        bearing,
        pitch,
        attributionControl: false,
        transformRequest: attributedRasterRequestTransform(),
        canvasContextAttributes: { antialias: true },
      });
      activeMap = map;
      const scale = new maplibregl.ScaleControl({ maxWidth: 100, unit: unitsRef.current });
      map.addControl(scale, "bottom-left");
      scaleRef.current = { map, control: scale };
      installedNativeBasemap(map).install(viewportStyle, setOfflinePackageActive, true);

      const applyStyleForViewport = (reason: string) => {
        const request = ++styleRequestRef.current;
        const currentStyle = currentStyleRef.current;
        void loadStyleForViewport(
          captureNativeBasemapRequest(env),
          currentStyle.variant,
          currentStyle.mapStyle,
          maplibregl,
        )
          .then((next) => {
            if (!isActive() || request !== styleRequestRef.current) return;
            installedNativeBasemap(map).install(next, setOfflinePackageActive);
          })
          .catch((err) => {
            if (!isActive() || request !== styleRequestRef.current) return;
            console.warn(`Unable to switch map style for ${reason}`, err);
          });
      };

      map.on("moveend", (e) => {
        if (!isActive() || attemptFailed) return;
        // The navigation follow camera drives the map with a programmatic
        // jumpTo every animation frame; skip those so we don't write to the
        // store 60×/s while navigating. Bail before reading the camera at all:
        // getCenter() allocates, and this is the hottest listener on the map
        // during a trip. User gestures and other programmatic moves (flyTo,
        // deep links) still persist as before.
        if (
          (e as { programmatic?: boolean })?.programmatic &&
          useNavigationStore.getState().status !== "idle"
        ) {
          return;
        }
        const c = map.getCenter();
        const center: LngLat = [c.lng, c.lat];
        setCenter(center);
        setZoom(map.getZoom());
        setBearing(map.getBearing());
        setPitch(map.getPitch());
        writeLastMapView({ center, zoom: map.getZoom() });
      });

      mapRef.current = map;

      // Every later style load — a dark/light swap, a basemap switch — bumps the
      // counter layers rebuild on. Registering it once here rather than per swap
      // is what makes that unconditional: a `once` attached after `setStyle` is
      // called can miss a style that resolves from cache, and the counter then
      // never moves for the rest of the session.
      map.on("style.load", () => {
        if (isActive()) notifyStyleReload();
      });

      const reloadForConnectivity = () => {
        if (!isActive()) return;
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
      let initialStyleFailed = false;
      const handleInitialStyleError = (event: maplibregl.ErrorEvent) => {
        if (!isActive() || initialStyleFailed) return;
        const eventStyle = (event as maplibregl.ErrorEvent & { style?: maplibregl.Style }).style;
        // MapLibre sets Style._loaded only after root-style validation succeeds.
        // Source/tile errors happen later and must not dispose a usable map.
        if (
          eventStyle !== map.style ||
          map.style._loaded ||
          "sourceId" in event ||
          "tile" in event
        ) {
          console.error(event.error);
          return;
        }
        attemptFailed = true;
        initialStyleFailed = true;
        map.off("error", handleInitialStyleError);
        // MapLibre may still be dispatching the validation event. Dispose after
        // that dispatch finishes, so it cannot continue into a removed style.
        queueMicrotask(() => {
          if (!isActive()) return;
          dispose();
          containerRef.current?.replaceChildren();
          console.error("Failed to initialize map", event.error);
          setStatus("error");
        });
      };
      const markReady = () => {
        if (!isActive() || initialStyleFailed || mapRef.current !== map) return;
        map.off("error", handleInitialStyleError);
        notifyMapReady();
        setStatus("ready");
      };
      // Parsed styles are usable while tiles are pending; style.load may
      // already have fired when a cached style finished during construction.
      if (map.getStyle()) {
        markReady();
      } else {
        map.on("error", handleInitialStyleError);
        map.once("style.load", markReady);
      }
      return map;
    };

    // Render the saved viewport immediately. A granted geolocation permission
    // must not become a startup dependency: browsers are allowed to leave
    // getCurrentPosition pending indefinitely while a provider is unavailable.
    const mapInitialization = initMap(center, zoom).catch((err) => {
      if (!isActive()) return undefined;
      attemptFailed = true;
      dispose();
      // A constructor may append DOM before throwing without returning an instance.
      containerRef.current?.replaceChildren();
      console.error("Failed to initialize map", err);
      setStatus("error");
      return undefined;
    });

    // If location permission is already granted, move to the user's location
    // (zoom 14) and show the marker when it arrives — without prompting. Opening
    // the map is not a moment to spend somebody's one permission prompt.
    // A view the page opened on (a shared link, a reload, the view the map was
    // last left on) or a move the user made while the fix was on its way wins:
    // the fix then only places the marker. A slow fix used to pull a linked
    // view, and what was being searched there, over to the user's own town.
    let cameraTaken = linkedView || lastView !== null;
    const recenter = (lngLat: LngLat) =>
      void mapInitialization.then((map) => {
        if (!isActive() || attemptFailed || !map || mapRef.current !== map) return;
        setUserLocation(lngLat);
        if (cameraTaken) return;
        map.jumpTo({ center: lngLat, zoom: 14 }, { programmatic: true });
      });

    const takeFix = () => {
      void mapInitialization.then((map) =>
        map?.on("movestart", (event: { originalEvent?: unknown }) => {
          if (event.originalEvent) cameraTaken = true;
        }),
      );
      void requestFix().then((result) => {
        if (!isActive() || attemptFailed || result.status !== "ok") return;
        recenter([result.fix.lng, result.fix.lat]);
      });
    };

    if (locationAuthority === "native") {
      // The shell already told us what the OS granted it, so no query is needed
      // and none would be meaningful inside a WebView anyway.
      if (nativePermission === "foreground" || nativePermission === "background") takeFix();
    } else if (navigator.permissions && navigator.geolocation) {
      navigator.permissions
        .query({ name: "geolocation" })
        .then((result) => {
          if (!isActive() || attemptFailed) return;
          if (result.state === "granted") takeFix();
        })
        .catch(() => undefined);
    }

    return () => {
      destroyed = true;
      dispose();
    };
  }, [
    env,
    locationAuthority,
    mapRef,
    nativePermission,
    notifyMapReady,
    notifyStyleReload,
    requestFix,
    retryKey,
    setBearing,
    setCenter,
    setPitch,
    setUserLocation,
    setZoom,
  ]);

  // The persisted unit preference changes the existing control, not the map.
  useEffect(() => {
    const scale = scaleRef.current;
    if (scale && mapRef.current === scale.map) scale.control.setUnit(units);
  }, [mapRef, units]);

  const retry = () => {
    attemptRef.current++;
    setStatus("loading");
    setRetryKey((key) => key + 1);
  };

  // Swap map tile style when dark/light mode changes
  const initialStyleRef = useRef(mapStyle);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    // Skip on first render — the map was already created with this style
    if (mapStyle === initialStyleRef.current) return;
    initialStyleRef.current = mapStyle;

    const request = ++styleRequestRef.current;
    const acquisition = captureNativeBasemapRequest(env);
    loadMapLibreRuntime()
      .then((module) =>
        loadStyleForViewport(acquisition, variant, mapStyle, module as MapLibreRuntime),
      )
      .then((s) => {
        if (request !== styleRequestRef.current || mapRef.current !== map) return;
        // The persistent `style.load` listener registered at map creation bumps
        // styleVersion once the new style lands.
        installedNativeBasemap(map).install(s, setOfflinePackageActive);
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

    return subscribeStyleLoaded(map, () => localizeMapLabels(map, locale));
  }, [locale, mapRef, mapReady]);

  // Outer div owns the absolute positioning.
  // MapLibre gets the inner div so its .maplibregl-map class (position: relative)
  // doesn't clobber the inset, which only works on absolutely-positioned elements.
  return (
    <Box sx={{ position: "absolute", inset: 0 }}>
      <Box
        ref={containerRef}
        sx={{
          width: "100%",
          height: "100%",
          "& .maplibregl-ctrl-bottom-left > .maplibregl-ctrl-scale": {
            display: scaleVisible ? "block" : "none",
            marginLeft: `${scaleLeft}px`,
            marginBottom: `${scaleFollow ? scaleFollow.base : scaleBottom}px`,
            ...sheetFollowSx(scaleFollow),
            pointerEvents: "none",
            bgcolor: "background.paper",
            color: "text.primary",
            borderColor: "currentColor",
            fontSize: 10,
          },
        }}
      />
      {status !== "ready" && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
          }}
        >
          <Box
            role={status === "error" ? "alert" : "status"}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              maxWidth: "min(320px, calc(100% - 32px))",
              p: 2,
              borderRadius: 2,
              bgcolor: "background.paper",
              boxShadow: 3,
              pointerEvents: "auto",
            }}
          >
            {status === "loading" ? (
              <>
                <CircularProgress size={20} aria-hidden="true" />
                <Typography variant="body2">{t("loading")}</Typography>
              </>
            ) : (
              <Box>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  {t("loadError")}
                </Typography>
                <Button variant="contained" size="small" onClick={retry}>
                  {tCommon("retry")}
                </Button>
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
