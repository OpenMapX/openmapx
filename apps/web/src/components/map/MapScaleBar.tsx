"use client";

import Box from "@mui/material/Box";
import { useSettingsStore } from "@openmapx/core";
import { useEffect, useState } from "react";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { type MapScale, mapScale } from "@/lib/mapScale";

/** Widest the bar may grow, in CSS pixels. */
const MAX_WIDTH = 64;

/**
 * The distance scale as a footer item: a round distance and a bar of that
 * length, measured across the middle of the map and kept current while it moves.
 */
export function MapScaleBar() {
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

  if (!scale) return null;
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
