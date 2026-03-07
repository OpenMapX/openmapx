"use client";

import BoyIcon from "@mui/icons-material/Boy";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import { useStreetViewStore } from "@openmapx/core";
import { useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";

// Must match the layer IDs defined in StreetViewLayer.tsx
const MLY_PHOTO_LAYER = "mapillary-photo-layer";
const MLY_PANO_LAYER = "mapillary-pano-layer";

const SEARCH_BUF = 20; // feature query buffer (px) — logic only
const CIRCLE_R = 10; // visual indicator radius — smaller than the boy
const GHOST_SIZE = 38; // px rendered height of the ghost icon
// Boy icon feet land at y=20 in a 24-unit viewBox
const PIN_TIP_OFFSET = GHOST_SIZE * (20 / 24);

export function Pegman() {
  const { mapRef, mapReady } = useMap();
  const setShowCoverage = useStreetViewStore((s) => s.setShowCoverage);
  const setActiveImageId = useStreetViewStore((s) => s.setActiveImageId);

  const [dragging, setDragging] = useState(false);
  const [ghostPos, setGhostPos] = useState({ x: 0, y: 0 });
  const pegmanRef = useRef<HTMLDivElement>(null);

  const findNearestDot = (clientX: number, clientY: number) => {
    const map = mapRef.current;
    if (!map || !mapReady) return null;

    const rect = map.getCanvas().getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const feature = map.queryRenderedFeatures(
      [
        [x - SEARCH_BUF, y - SEARCH_BUF],
        [x + SEARCH_BUF, y + SEARCH_BUF],
      ],
      { layers: [MLY_PHOTO_LAYER, MLY_PANO_LAYER] },
    )[0];

    if (!feature || feature.geometry.type !== "Point") return null;

    const [lng, lat] = feature.geometry.coordinates as [number, number];
    const screenPt = map.project([lng, lat]);
    return {
      screenX: screenPt.x + rect.left,
      screenY: screenPt.y + rect.top,
      id: feature.properties?.id as string | number | null,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    pegmanRef.current?.setPointerCapture(e.pointerId);
    setDragging(true);
    setGhostPos({ x: e.clientX, y: e.clientY });
    setShowCoverage(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setGhostPos({ x: e.clientX, y: e.clientY });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);

    const dot = findNearestDot(e.clientX, e.clientY);
    if (dot?.id != null) {
      setShowCoverage(false);
      setActiveImageId(String(dot.id));
    } else {
      setShowCoverage(false);
    }
  };

  return (
    <>
      <Tooltip title="Street-level imagery" placement="left">
        <Paper
          ref={pegmanRef}
          component="div"
          elevation={2}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          sx={{
            borderRadius: "12px",
            width: 36,
            height: 36,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: dragging ? "grabbing" : "grab",
            touchAction: "none",
            userSelect: "none",
            flexShrink: 0,
          }}
        >
          <BoyIcon sx={{ fontSize: 22, color: "#FB8C00" }} />
        </Paper>
      </Tooltip>

      {dragging && (
        <>
          {/* Dashed search-area circle centred on the feet */}
          <Box
            sx={{
              position: "fixed",
              left: ghostPos.x - CIRCLE_R,
              top: ghostPos.y - CIRCLE_R,
              width: CIRCLE_R * 2,
              height: CIRCLE_R * 2,
              borderRadius: "50%",
              border: "2px dashed rgba(0,0,0,0.75)",
              bgcolor: "transparent",
              pointerEvents: "none",
              zIndex: 9998,
            }}
          />

          {/* Ghost icon — pin tip precisely at cursor */}
          <Box
            sx={{
              position: "fixed",
              left: ghostPos.x - GHOST_SIZE / 2,
              top: ghostPos.y - PIN_TIP_OFFSET,
              pointerEvents: "none",
              zIndex: 9999,
              filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.45))",
            }}
          >
            <BoyIcon sx={{ fontSize: GHOST_SIZE, color: "#FB8C00" }} />
          </Box>
        </>
      )}
    </>
  );
}
