"use client";

import Box from "@mui/material/Box";
import { useColorScheme } from "@mui/material/styles";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { loadOpenMapXStyle, maptilerStyleUrl } from "@/lib/map";
import type { OfflineAreaBbox } from "@/lib/offlineAreas";

interface Props {
  initialCenter: [number, number];
  initialZoom: number;
  onChange: (bbox: OfflineAreaBbox, zoom: number) => void;
}

/**
 * Mini MapLibre instance used as the bbox picker. Whatever the user has visible
 * is the area they'll download — a simple, gesture-driven picker that mirrors
 * how Google Maps' "download offline area" works.
 */
export function AreaPickerMap({ initialCenter, initialZoom, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const env = useEnv();
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = mode === "system" ? systemMode : mode;
  const styleName = resolvedMode === "dark" ? "streets-v2-dark" : "bright-v2";

  // biome-ignore lint/correctness/useExhaustiveDependencies: initialCenter / initialZoom intentionally captured at mount only — re-creating the map on every prop change would lose the user's pan/zoom state mid-selection.
  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;
    let map: maplibregl.Map | null = null;

    const init = async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (destroyed || !containerRef.current) return;
      const style =
        env.styleProvider === "openmapx"
          ? await loadOpenMapXStyle(env)
          : maptilerStyleUrl(styleName, env);
      if (destroyed || !containerRef.current) return;
      map = new maplibregl.Map({
        container: containerRef.current,
        style: style as string | maplibregl.StyleSpecification,
        center: initialCenter,
        zoom: initialZoom,
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
      });

      const emit = () => {
        if (!map) return;
        const b = map.getBounds();
        onChange(
          {
            west: b.getWest(),
            south: b.getSouth(),
            east: b.getEast(),
            north: b.getNorth(),
          },
          map.getZoom(),
        );
      };

      map.on("load", emit);
      map.on("moveend", emit);
    };

    void init();

    return () => {
      destroyed = true;
      map?.remove();
    };
  }, [env, styleName, onChange]);

  return (
    <Box
      sx={{
        position: "relative",
        width: "100%",
        height: 320,
        borderRadius: 2,
        overflow: "hidden",
        border: 1,
        borderColor: "divider",
      }}
    >
      <Box ref={containerRef} sx={{ position: "absolute", inset: 0 }} />
      {/* Crosshair overlay — visualizes the bbox center */}
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          "&::before": {
            content: '""',
            position: "absolute",
            inset: 12,
            border: "2px dashed rgba(0,0,0,0.45)",
            borderRadius: 1,
          },
        }}
      />
    </Box>
  );
}
