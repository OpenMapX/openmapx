"use client";

import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import { useEffect, useState } from "react";
import { CHIP_ROW_END } from "@/components/search/floatingChipSx";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { SEARCH_BAR_INSET, topInset } from "@/lib/layout";
import { type MapScale, mapScale } from "@/lib/mapScale";

/** Widest the bar may grow, in CSS pixels. */
const MAX_WIDTH = 64;
/** How long the phone overlay stays after the zoom settles. */
const OVERLAY_LINGER_MS = 1500;

/** Keeps a scale measured across the middle of the map while it moves. */
function useMapScale(): MapScale | null {
  const mapContext = useMapOptional();
  const mapRef = mapContext?.mapRef;
  const mapReady = mapContext?.mapReady ?? false;
  const units = useSettingsStore((s) => s.units);
  const [scale, setScale] = useState<MapScale | null>(null);

  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !mapReady) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const y = map.getContainer().clientHeight / 2;
      const metres = map.unproject([0, y]).distanceTo(map.unproject([MAX_WIDTH, y]));
      setScale(mapScale(metres, MAX_WIDTH, units));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    map.on("move", schedule);
    return () => {
      map.off("move", schedule);
      cancelAnimationFrame(frame);
    };
  }, [mapRef, mapReady, units]);

  return scale;
}

function ScaleReadout({ scale }: { scale: MapScale }) {
  return (
    <Box
      component="span"
      data-testid="map-scale"
      sx={{ display: "inline-flex", alignItems: "center", gap: "0.5em", whiteSpace: "nowrap" }}
    >
      {`${scale.value} ${scale.unit}`}
      <Box
        component="span"
        aria-hidden
        sx={{
          width: scale.width,
          height: 5,
          border: "1.5px solid currentColor",
          borderTop: "none",
        }}
      />
    </Box>
  );
}

/**
 * The distance scale. In the desktop footer it is always shown; on a phone it
 * appears under the chip row only while the map zooms, then fades away.
 */
export function MapScaleBar({ variant = "footer" }: { variant?: "footer" | "overlay" }) {
  const scale = useMapScale();
  if (!scale) return null;
  return variant === "footer" ? <ScaleReadout scale={scale} /> : <ZoomScaleOverlay scale={scale} />;
}

function ZoomScaleOverlay({ scale }: { scale: MapScale }) {
  const mapContext = useMapOptional();
  const mapRef = mapContext?.mapRef;
  const mapReady = mapContext?.mapReady ?? false;
  const phone = useMediaQuery(useTheme().breakpoints.down("sm"));
  // Turn-by-turn guidance has no use for a distance scale.
  const groundNavigating = useNavigationStore((s) => s.status !== "idle" && s.kind === "ground");
  const [zooming, setZooming] = useState(false);

  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !mapReady || !phone) return;
    let timer: number | undefined;
    const onZoom = () => {
      window.clearTimeout(timer);
      setZooming(true);
    };
    const onZoomEnd = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setZooming(false), OVERLAY_LINGER_MS);
    };
    map.on("zoom", onZoom);
    map.on("zoomend", onZoomEnd);
    return () => {
      window.clearTimeout(timer);
      map.off("zoom", onZoom);
      map.off("zoomend", onZoomEnd);
    };
  }, [mapRef, mapReady, phone]);

  if (!phone || groundNavigating) return null;
  return (
    <Box
      aria-hidden
      sx={(theme) => ({
        position: "absolute",
        top: topInset(SEARCH_BAR_INSET, CHIP_ROW_END.xs + 12),
        left: "calc(12px + var(--omx-safe-left))",
        zIndex: 5,
        pointerEvents: "none",
        fontSize: 12,
        fontWeight: 500,
        color: "text.primary",
        // A halo in the page colour keeps it legible over any map imagery.
        textShadow: `0 0 3px ${(theme.vars ?? theme).palette.background.paper}`,
        filter: `drop-shadow(0 0 1px ${(theme.vars ?? theme).palette.background.paper})`,
        opacity: zooming ? 1 : 0,
        transition: "opacity 0.3s ease",
      })}
    >
      <ScaleReadout scale={scale} />
    </Box>
  );
}
