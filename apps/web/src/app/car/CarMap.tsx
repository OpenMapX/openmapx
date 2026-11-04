"use client";
import { TrafficFlowLayer } from "@integrations/overlay-traffic-flow/map-layer";
import Box from "@mui/material/Box";
import { useColorScheme } from "@mui/material/styles";
import { isOverSpeed, useNavigationStore } from "@openmapx/core";
import type { CarPosition, CarPreview, CarViewport } from "@openmapx/core/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BaseAttributions } from "@/components/map/BaseAttributions";
import { ContextualOverlays } from "@/components/map/ContextualOverlays";
import { NavigationRouteLayer } from "@/components/map/layers/NavigationRouteLayer";
import { RouteTrafficLayer } from "@/components/map/layers/RouteTrafficLayer";
import { MapCanvas } from "@/components/map/MapCanvas";
import { SpeedLimitBadge } from "@/components/navigation/SpeedLimitBadge";
import { AttributionLogos } from "@/components/ui/AttributionNotices";
import { AttributionText } from "@/components/ui/AttributionText";
import { useMap } from "@/integration-api/map/MapContext";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useMapAttributionPresentation } from "@/integration-api/overlay/mapAttributionStore";
import { useNavCamera } from "@/lib/navigation/useNavCamera";
import { CarConditionsLayer } from "./CarConditionsLayer";
import {
  boundsOf,
  carLabelSize,
  carLayout,
  fitCarBounds,
  routeLabelPoints,
  routeLetter,
} from "./carSurface";
import { useCarPositionMarker } from "./useCarPositionMarker";

/** Width of the host's map control column (buttons plus margin) on Android Auto. */
const MAP_CONTROLS_WIDTH = 88;

export function CarMap({
  viewport,
  preview,
  position,
  units,
  error,
}: {
  viewport: CarViewport;
  preview: CarPreview | null;
  position: CarPosition | null;
  units: "metric" | "imperial";
  error: (code: string) => void;
}) {
  const layout = useMemo(() => carLayout(viewport), [viewport]);
  useNavCamera(layout);
  const { setMode } = useColorScheme();
  const { mapRef, mapReady, styleVersion } = useMap();
  const speed = useNavigationStore((s) => s.progress?.speedMps);
  const limit = useNavigationStore((s) => s.currentSpeedLimit);
  const active = useNavigationStore((s) => s.status !== "idle");
  useCarPositionMarker({
    position: active || preview?.routes.length ? null : position,
    // Centre in what is visible now; the stable area can still hold a closed list's inset.
    stable: viewport.visible,
  });
  // Without a trip the speed comes from the idle position feed; choosing a route shows none.
  const previewing = !!preview?.routes.length;
  const shownSpeed = previewing ? undefined : active ? speed : position?.speedMps;
  const credits = useMapAttributionPresentation();
  const s = viewport.stable;
  // The map controls stay on screen, but hosts do not always exclude them from the stable
  // area; overlays keep clear of the column they occupy.
  const right = Math.max(s.right, viewport.visible.right, MAP_CONTROLS_WIDTH);
  const creditsRef = useRef<HTMLDivElement>(null);
  const [creditsHeight, setCreditsHeight] = useState(24);
  useEffect(() => {
    const element = creditsRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setCreditsHeight(element.getBoundingClientRect().height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setMode(viewport.dark ? "dark" : "light");
  }, [viewport.dark, setMode]);
  useEffect(() => {
    void viewport;
    mapRef.current?.resize();
  }, [viewport, mapRef]);
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const apply = () => {
      for (const layer of map.getStyle().layers ?? []) {
        if (layer.type !== "symbol" || !layer.layout?.["text-field"]) continue;
        const enlarged = carLabelSize(layer.layout);
        map.setLayoutProperty(layer.id, "text-size", enlarged.textSize);
        if (enlarged.iconSize !== undefined)
          map.setLayoutProperty(layer.id, "icon-size", enlarged.iconSize);
      }
    };
    apply();
    map.on("style.load", apply);
    return () => {
      map.off("style.load", apply);
    };
  }, [mapRef, mapReady, styleVersion]);
  const group = useMemo(
    () => ({
      sources: {
        "car-preview-labels": {
          type: "geojson" as const,
          data: {
            type: "FeatureCollection" as const,
            features: routeLabelPoints(preview?.routes ?? []).map((point, i) => ({
              type: "Feature" as const,
              properties: {
                letter: routeLetter(i),
                selected: preview && "selected" in preview && preview.selected === i,
              },
              geometry: { type: "Point" as const, coordinates: point },
            })),
          },
        },
        "car-preview": {
          type: "geojson" as const,
          data: {
            type: "FeatureCollection" as const,
            features: (preview?.routes ?? []).map((r, i) => ({
              type: "Feature" as const,
              properties: { selected: preview && "selected" in preview && preview.selected === i },
              geometry: { type: "LineString" as const, coordinates: r.coordinates },
            })),
          },
        },
      },
      layers: [
        {
          id: "car-preview-lines",
          type: "line" as const,
          source: "car-preview",
          layout: {
            "line-cap": "round" as const,
            "line-join": "round" as const,
            // The selected route is drawn above the alternatives it overlaps.
            "line-sort-key": [
              "case",
              ["get", "selected"],
              1,
              0,
            ] as import("maplibre-gl").ExpressionSpecification,
          },
          paint: {
            "line-color": [
              "case",
              ["get", "selected"],
              "#1a73e8",
              "#8799b5",
            ] as import("maplibre-gl").ExpressionSpecification,
            "line-width": 9,
          },
          slot: "route-active" as const,
          order: 10,
        },
        // The same letters as the car's route list, on each route where it leaves the others,
        // above the base map's labels so a place name cannot hide one.
        {
          id: "car-preview-label-badges",
          type: "circle" as const,
          source: "car-preview-labels",
          paint: {
            "circle-radius": 17,
            "circle-color": [
              "case",
              ["get", "selected"],
              "#1a73e8",
              "#5f6f86",
            ] as import("maplibre-gl").ExpressionSpecification,
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 3,
          },
          slot: "route-markers" as const,
          order: 30,
        },
        {
          id: "car-preview-label-letters",
          type: "symbol" as const,
          source: "car-preview-labels",
          layout: {
            "text-field": ["get", "letter"] as import("maplibre-gl").ExpressionSpecification,
            "text-font": ["Noto Sans Bold"],
            "text-size": 20,
            "text-allow-overlap": true,
            "text-ignore-placement": true,
          },
          paint: { "text-color": "#ffffff" },
          slot: "route-markers" as const,
          order: 31,
        },
      ],
    }),
    [preview],
  );
  useMapLayerGroup(group);
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !preview?.routes.length) return;
    const bounds = boundsOf(preview.routes.flatMap((route) => route.coordinates));
    // Framing a preview is not a user zoom; follow mode keeps its own zoom afterwards.
    if (bounds) fitCarBounds(map, bounds, s, 0);
  }, [preview, mapReady, mapRef, s]);
  return (
    <>
      <MapCanvas carSurface onSurfaceError={error} />
      <BaseAttributions />
      <NavigationRouteLayer />
      <CarConditionsLayer />
      <RouteTrafficLayer navigationOnly />
      <TrafficFlowLayer />
      <ContextualOverlays />
      <Box
        sx={{
          // Bottom right of the safe area, beside the map controls, as Google Maps places it.
          position: "absolute",
          right: right + 12,
          bottom: s.bottom + creditsHeight + 12,
          display: "flex",
          alignItems: "center",
          gap: 1,
          pointerEvents: "none",
        }}
      >
        <SpeedLimitBadge
          size={72}
          speedLimit={active && !previewing ? limit : null}
          units={units}
          over={isOverSpeed(speed ?? 0, limit)}
        />
        {shownSpeed !== undefined && (
          <Box
            sx={{
              bgcolor: "background.paper",
              color: active && isOverSpeed(speed ?? 0, limit) ? "error.main" : "text.primary",
              borderRadius: "50%",
              width: 84,
              height: 84,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: 2,
            }}
          >
            <Box sx={{ fontSize: 36, lineHeight: 1, fontWeight: 700 }}>
              {Math.round(shownSpeed * (units === "imperial" ? 2.23694 : 3.6))}
            </Box>
            <Box sx={{ fontSize: 15 }}>{units === "imperial" ? "mph" : "km/h"}</Box>
          </Box>
        )}
      </Box>
      <Box
        ref={creditsRef}
        sx={{
          position: "absolute",
          left: s.left,
          right,
          bottom: s.bottom,
          color: "text.primary",
          fontSize: 12,
          textAlign: "right",
          px: 1,
          pointerEvents: "none",
        }}
      >
        <AttributionLogos logos={credits.visible.flatMap((n) => n.logos)} />
        {credits.fullHtml.map((html, index) => (
          <Box component="span" key={html} sx={{ bgcolor: "background.paper" }}>
            {index > 0 && " | "}
            <AttributionText html={html} />
          </Box>
        ))}
      </Box>
    </>
  );
}
