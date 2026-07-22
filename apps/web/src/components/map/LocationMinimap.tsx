"use client";

import Box from "@mui/material/Box";
import { type SxProps, type Theme, useColorScheme } from "@mui/material/styles";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { baseMapCustomAttribution, loadMaptilerStyle, loadOpenMapXStyle } from "@/lib/map";

/**
 * Collapse MapLibre's compact attribution control to its info button.
 *
 * With `compact: true`, MapLibre 5's `_updateCompact()` renders the control
 * EXPANDED on init — it sets the `open` attribute and adds
 * `maplibregl-compact-show` — and only minimises again in response to a map
 * interaction. A minimap is non-interactive, so nothing ever collapses it, and
 * on a map this small the attribution strip covers most of the view. This
 * mirrors MapLibre's own `_updateCompactMinimize` (removing the show class),
 * and also clears `open` for good measure.
 */
export function collapseCompactAttribution(container: HTMLElement): void {
  const attrib = container.querySelector<HTMLElement>(".maplibregl-ctrl-attrib.maplibregl-compact");
  attrib?.classList.remove("maplibregl-compact-show");
  attrib?.removeAttribute("open");
}

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

      // MapLibre's compact attribution renders EXPANDED on init and only
      // minimises on a map interaction — which never happens on a
      // non-interactive minimap (see collapseCompactAttribution). Re-run on
      // resize in case MapLibre re-expands it.
      const collapse = () => collapseCompactAttribution(el);
      map.once("idle", collapse);
      map.on("resize", collapse);

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
