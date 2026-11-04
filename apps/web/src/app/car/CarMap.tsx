"use client";
import { TrafficFlowLayer } from "@integrations/overlay-traffic-flow/map-layer";
import Box from "@mui/material/Box";
import { useColorScheme } from "@mui/material/styles";
import { isOverSpeed, useNavigationStore } from "@openmapx/core";
import type { CarPreview, CarViewport } from "@openmapx/core/navigation";
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
import { carLayout } from "./carSurface";

export function CarMap({
  viewport,
  preview,
  units,
  error,
}: {
  viewport: CarViewport;
  preview: CarPreview | null;
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
  const credits = useMapAttributionPresentation();
  const s = viewport.stable;
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
        if (layer.type === "symbol" && layer.layout?.["text-field"]) {
          map.setLayoutProperty(layer.id, "text-size", 24);
        }
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
          layout: { "line-cap": "round" as const, "line-join": "round" as const },
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
      ],
    }),
    [preview],
  );
  useMapLayerGroup(group);
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !preview?.routes.length) return;
    let west = 180,
      south = 90,
      east = -180,
      north = -90;
    for (const route of preview.routes)
      for (const [lng, lat] of route.coordinates) {
        west = Math.min(west, lng);
        east = Math.max(east, lng);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      {
        padding: {
          ...s,
          top: s.top + 32,
          bottom: s.bottom + 90,
          left: s.left + 32,
          right: s.right + 32,
        },
        pitch: 0,
        bearing: 0,
        duration: 0,
        maxZoom: 16,
      },
    );
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
          position: "absolute",
          left: s.left + 12,
          bottom: s.bottom + creditsHeight + 12,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          pointerEvents: "none",
        }}
      >
        <SpeedLimitBadge
          speedLimit={active ? limit : null}
          units={units}
          over={isOverSpeed(speed ?? 0, limit)}
        />
        {active && speed !== undefined && (
          <Box
            sx={{
              bgcolor: "background.paper",
              color: "text.primary",
              borderRadius: 2,
              px: 1.5,
              py: 0.5,
              textAlign: "center",
            }}
          >
            <Box sx={{ fontSize: 32, lineHeight: 1.1, fontWeight: 700 }}>
              {Math.round(speed * (units === "imperial" ? 2.23694 : 3.6))}
            </Box>
            <Box sx={{ fontSize: 16 }}>{units === "imperial" ? "mph" : "km/h"}</Box>
          </Box>
        )}
      </Box>
      <Box
        ref={creditsRef}
        sx={{
          position: "absolute",
          left: s.left,
          right: s.right,
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
