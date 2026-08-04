"use client";

import Box from "@mui/material/Box";
import { type SxProps, type Theme, useColorScheme } from "@mui/material/styles";
import type { StyleSpecification } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { baseMapCreditsHtml, loadMaptilerStyle, loadOpenMapXStyle } from "@/lib/map";
import { MapCredits } from "./MapCredits";

interface LocationMinimapProps {
  lng: number;
  lat: number;
  zoom?: number;
  onClick?: () => void;
  sx?: SxProps<Theme>;
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
  const mapRef = useRef<{ map: unknown; marker: unknown } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: map created once, coords updated by second effect
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;

    (async () => {
      const [maplibregl, style] = await Promise.all([
        import("maplibre-gl"),
        env.styleProvider === "openmapx"
          ? loadOpenMapXStyle(env, variant)
          : loadMaptilerStyle("bright-v2", env),
      ]);
      if (cancelled || !el) return;

      const map = new maplibregl.Map({
        container: el,
        style: style as string | StyleSpecification,
        center: [lng, lat],
        zoom,
        interactive: false,
        // Credits are rendered by `<MapCredits>` below, matching the main map's
        // footer. MapLibre's own control renders EXPANDED on init on a
        // non-interactive map (nothing ever triggers its collapse), which
        // covered most of a map this small.
        attributionControl: false,
      });

      const marker = new maplibregl.Marker({ color: "#e53935" }).setLngLat([lng, lat]).addTo(map);

      mapRef.current = { map, marker };
    })().catch(() => {
      // Style load or MapLibre import failed — leave the container empty.
    });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        const { map } = mapRef.current as { map: { remove: () => void } };
        map.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    const { map, marker } = mapRef.current as {
      map: { flyTo: (opts: { center: [number, number]; duration: number }) => void };
      marker: { setLngLat: (coords: [number, number]) => void };
    };
    marker.setLngLat([lng, lat]);
    map.flyTo({ center: [lng, lat], duration: 300 });
  }, [lng, lat]);

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
