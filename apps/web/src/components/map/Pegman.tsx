"use client";

import BoyIcon from "@mui/icons-material/Boy";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import { useOverlayVisibilitySetter, useStreetLevelStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import {
  pictureLayerIds,
  providerIdByLayer,
} from "@/components/map/street-level-imagery/StreetLevelCoverageLayer";
import { useStreetLevelProviders } from "@/components/map/street-level-imagery/useStreetLevelProviders";
import { useMap } from "@/lib/MapContext";

const SEARCH_BUF = 20; // feature query buffer (px) — logic only
const CIRCLE_R = 10; // visual indicator radius — smaller than the boy
const GHOST_SIZE = 38; // px rendered height of the ghost icon
// Boy icon feet land at y=20 in a 24-unit viewBox
const PIN_TIP_OFFSET = GHOST_SIZE * (20 / 24);

export interface PegmanCandidate {
  id: string;
  providerId: string;
  screenX: number;
  screenY: number;
}

/** Closest candidate to a drop point, measured in screen pixels. */
export function nearestFeature(
  candidates: PegmanCandidate[],
  x: number,
  y: number,
): PegmanCandidate | null {
  let best: PegmanCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.screenX - x, candidate.screenY - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

export function Pegman() {
  const { mapRef, mapReady } = useMap();
  const t = useTranslations("streetLevel");
  const { providers } = useStreetLevelProviders();
  const setLayerVisible = useOverlayVisibilitySetter("street-level-imagery");
  const requestImageLoad = useStreetLevelStore((s) => s.requestImageLoad);
  const [dragging, setDragging] = useState(false);
  const [ghostPos, setGhostPos] = useState({ x: 0, y: 0 });
  const pegmanRef = useRef<HTMLDivElement>(null);

  // No street-level-imagery provider enabled → the feature hides entirely.
  if (providers.length === 0) return null;

  const findNearestDot = (clientX: number, clientY: number) => {
    const map = mapRef.current;
    if (!map || !mapReady) return null;

    const layers = pictureLayerIds(providers).filter((id) => !!map.getLayer(id));
    if (layers.length === 0) return null;

    const byLayer = providerIdByLayer(providers);
    const rect = map.getCanvas().getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const candidates: PegmanCandidate[] = [];
    for (const feature of map.queryRenderedFeatures(
      [
        [x - SEARCH_BUF, y - SEARCH_BUF],
        [x + SEARCH_BUF, y + SEARCH_BUF],
      ],
      { layers },
    )) {
      if (feature.geometry.type !== "Point") continue;
      const imageId = feature.properties?.id;
      const providerId = byLayer.get(feature.layer?.id ?? "");
      if (imageId == null || !providerId) continue;

      const [lng, lat] = feature.geometry.coordinates as [number, number];
      const point = map.project([lng, lat]);
      candidates.push({
        id: String(imageId),
        providerId,
        screenX: point.x,
        screenY: point.y,
      });
    }

    return nearestFeature(candidates, x, y);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    pegmanRef.current?.setPointerCapture(e.pointerId);
    setDragging(true);
    setGhostPos({ x: e.clientX, y: e.clientY });
    setLayerVisible(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setGhostPos({ x: e.clientX, y: e.clientY });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);

    const dot = findNearestDot(e.clientX, e.clientY);
    setLayerVisible(false);
    if (dot) requestImageLoad({ providerId: dot.providerId, imageId: dot.id });
  };

  return (
    <>
      <Tooltip title={t("streetLevelImagery")} placement="left">
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
