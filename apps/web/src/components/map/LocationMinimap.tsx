"use client";

import Box from "@mui/material/Box";
import { type SxProps, type Theme, useColorScheme } from "@mui/material/styles";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { baseMapCustomAttribution, loadMaptilerStyle, loadOpenMapXStyle } from "@/lib/map";

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
      const [{ default: maplibregl }, style] = await Promise.all([
        import("maplibre-gl"),
        env.styleProvider === "openmapx"
          ? loadOpenMapXStyle(env, variant)
          : loadMaptilerStyle("bright-v2", env),
      ]);
      if (cancelled || !el) return;

      const map = new maplibregl.Map({
        container: el,
        style: style as string | maplibregl.StyleSpecification,
        center: [lng, lat],
        zoom,
        interactive: false,
        attributionControl: { compact: true, customAttribution: baseMapCustomAttribution(env) },
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

  return <Box ref={containerRef} onClick={onClick} sx={sx} />;
}
