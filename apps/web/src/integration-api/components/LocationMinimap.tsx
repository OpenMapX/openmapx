"use client";

import Box from "@mui/material/Box";
import { type SxProps, type Theme, useColorScheme } from "@mui/material/styles";
import type { StyleSpecification } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { MapCredits } from "@/components/map/MapCredits";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { baseMapCreditsHtml, loadMaptilerStyle, loadOpenMapXStyle } from "@/lib/map";
import { loadMapLibreRuntime } from "@/lib/maplibreRuntime";

interface LocationMinimapProps {
  lng: number;
  lat: number;
  zoom?: number;
  onClick?: () => void;
  sx?: SxProps<Theme>;
}

interface MinimapInstance {
  map: {
    flyTo: (opts: { center: [number, number]; zoom?: number; duration: number }) => void;
    remove: () => void;
  };
  marker: { setLngLat: (coords: [number, number]) => unknown };
}

/**
 * Small non-interactive MapLibre map centered on a point, with a marker. Shared
 * by the photo gallery and the crowd-report dialog; callers control size and
 * placement via `sx`. Mirrors MapCanvas' style loading so it works against both
 * MapTiler and a self-hosted openmapx-streets tileserver.
 */
export function LocationMinimap({ lng, lat, zoom = 16, onClick, sx }: LocationMinimapProps) {
  const env = useEnv();
  const { mode, systemMode } = useColorScheme();
  const variant = (mode === "system" ? systemMode : mode) === "dark" ? "dark" : "light";
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MinimapInstance | null>(null);
  const cameraRef = useRef({ lng, lat, zoom });
  cameraRef.current = { lng, lat, zoom };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let instance: MinimapInstance | null = null;

    (async () => {
      const [maplibregl, style] = await Promise.all([
        loadMapLibreRuntime(),
        env.styleProvider === "openmapx"
          ? loadOpenMapXStyle(env, variant)
          : loadMaptilerStyle(variant === "dark" ? "streets-v2-dark" : "bright-v2", env),
      ]);
      if (cancelled || !el) return;

      const camera = cameraRef.current;

      const map = new maplibregl.Map({
        container: el,
        style: style as string | StyleSpecification,
        center: [camera.lng, camera.lat],
        zoom: camera.zoom,
        interactive: false,
        // Credits are rendered by `<MapCredits>` below, matching the main map's
        // footer. MapLibre's own control renders EXPANDED on init on a
        // non-interactive map (nothing ever triggers its collapse), which
        // covered most of a map this small.
        attributionControl: false,
      });

      let marker: InstanceType<typeof maplibregl.Marker>;
      try {
        marker = new maplibregl.Marker({ color: "#e53935" })
          .setLngLat([camera.lng, camera.lat])
          .addTo(map);
      } catch (error) {
        map.remove();
        throw error;
      }

      instance = { map, marker };
      mapRef.current = instance;
    })().catch(() => {
      // Style load or MapLibre import failed — leave the container empty.
    });

    return () => {
      cancelled = true;
      if (instance) {
        instance.map.remove();
        if (mapRef.current === instance) mapRef.current = null;
        instance = null;
      }
    };
  }, [env, variant]);

  useEffect(() => {
    if (!mapRef.current) return;
    const { map, marker } = mapRef.current;
    marker.setLngLat([lng, lat]);
    map.flyTo({ center: [lng, lat], zoom, duration: 300 });
  }, [lng, lat, zoom]);

  // The caller's `sx` positions and sizes the minimap; the map canvas fills it
  // and the credits pin themselves to its bottom-right corner. `position` is
  // pinned to whatever the caller set (they all position the minimap
  // absolutely), falling back to `relative` so the credits stay contained.
  return (
    <Box
      onClick={onClick}
      sx={[{ position: "relative" }, ...(Array.isArray(sx) ? sx : [sx])] as SxProps<Theme>}
    >
      <Box ref={containerRef} sx={{ position: "absolute", inset: 0 }} />
      <MapCredits compact html={baseMapCreditsHtml(env)} />
    </Box>
  );
}
