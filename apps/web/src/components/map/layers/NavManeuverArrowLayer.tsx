"use client";

import {
  cumulativeDistances,
  guidanceApproachMeters,
  laneShiftedArrowLine,
  type ManeuverArrowSpans,
  maneuverArrowLine,
  maneuverArrowSpans,
  maneuverArrowTipBearing,
  maneuverStartMeters,
  raisedArrowPolygon,
  smoothArrowLine,
  upcomingManeuverIndex,
  useNavigationStore,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useMemo, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import {
  EMPTY_FEATURE_COLLECTION,
  type MapLayerGroup,
  type SlottedLayer,
} from "@/integration-api/map/mapLayerGroup";
import { highlightLanePath, useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";

const SOURCE = "nav-maneuver-arrow-source";
const CASING = "nav-maneuver-arrow-casing";
const BODY = "nav-maneuver-arrow";
const HEAD = "nav-maneuver-arrow-head";
export const MANEUVER_ARROW_HEAD_IMAGE_ID = "nav-maneuver-arrow-head-icon";

const RAISED = "nav-maneuver-arrow-raised";

const CASING_COLOR = "#1b1b1b";
const BODY_COLOR = "#ffffff";
const RAISED_WIDTH_M = 2.4;
const RAISED_HEAD_M = 5;
const RAISED_BASE_M = 0.8;
const RAISED_TOP_M = 1.1;
const RAISED_MIN_ZOOM = 16.5;

/** Maneuver types that are never worth marking with an arrow. */
const NON_JUNCTION_TYPES = new Set(["depart", "arrive"]);

/**
 * Draw the route-following arrow through the upcoming maneuver while it is
 * inside the approach window. Sits in the `route-markers` slot, above the
 * basemap labels, so the arrow is never hidden by shields. The source is
 * republished when the route, the upcoming step index or the approach flag
 * changes — never per fix.
 */
export function NavManeuverArrowLayer() {
  const status = useNavigationStore((s) => s.status);
  const route = useNavigationStore((s) => s.route);
  const mode = useNavigationStore((s) => s.mode);
  const currentStepIndex = useNavigationStore((s) => s.progress?.currentStepIndex);
  const distanceToNextManeuver = useNavigationStore((s) => s.progress?.distanceToNextManeuver);
  const speedMps = useNavigationStore((s) => s.progress?.speedMps);

  const highlightSpan = useNavigationSceneStore((s) => s.highlightSpan);
  const upcomingIndex = route
    ? upcomingManeuverIndex(currentStepIndex ?? 0, route.steps?.length ?? 0)
    : 0;
  const approaching =
    !!route &&
    distanceToNextManeuver !== undefined &&
    distanceToNextManeuver <= guidanceApproachMeters(mode, speedMps ?? 0);

  const data = useMemo(() => {
    if (status !== "navigating" && status !== "rerouting") return EMPTY_FEATURE_COLLECTION;
    if (!route || !approaching || route.geometry.length < 2) return EMPTY_FEATURE_COLLECTION;
    const step = route.steps[upcomingIndex];
    if (!step?.maneuver || NON_JUNCTION_TYPES.has(step.maneuver.type))
      return EMPTY_FEATURE_COLLECTION;
    const cum = cumulativeDistances(route.geometry);
    const alongMeters = maneuverStartMeters(route, upcomingIndex);
    const spans: ManeuverArrowSpans = maneuverArrowSpans(mode);
    const routeLine = maneuverArrowLine(route.geometry, cum, alongMeters, spans);
    // With a lane highlight, the arrow runs in the highlighted lane where the
    // car is drawn, so they never point at different lanes. That lane is on
    // the turning side, so the arrow cuts the corner through the junction and
    // rejoins the route line just before its head.
    const lanePath = highlightLanePath(highlightSpan, route, upcomingIndex);
    const followed =
      routeLine && lanePath
        ? laneShiftedArrowLine(routeLine, Math.max(0, alongMeters - spans.before), lanePath)
        : routeLine;
    // Smoothed, so a sideways step in the route (a road splitting into two
    // carriageways near the junction) reads as a gentle bend, not a zig-zag.
    const line = followed && smoothArrowLine(followed);
    const tip = line?.at(-1);
    if (!line || !tip || line.length < 2) return EMPTY_FEATURE_COLLECTION;
    const bearing = maneuverArrowTipBearing(line);
    const outline = raisedArrowPolygon(line, RAISED_WIDTH_M, RAISED_HEAD_M, {
      drivingSide: step.drivingSide,
    });
    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: { bearing },
          geometry: { type: "LineString" as const, coordinates: line },
        },
        {
          type: "Feature" as const,
          properties: { bearing },
          geometry: { type: "Point" as const, coordinates: tip },
        },
        ...(outline.length > 0
          ? [
              {
                type: "Feature" as const,
                properties: {},
                geometry: { type: "Polygon" as const, coordinates: [outline] },
              },
            ]
          : []),
      ],
    };
  }, [status, route, upcomingIndex, approaching, mode, highlightSpan]);

  // In 3D navigation, from z16.5 (where 2.4 m is wide enough to read), the
  // arrow stands in the scene instead of being painted over it.
  const sceneActive = useNavigationSceneStore((s) => s.active);
  const { mapRef, mapReady } = useMap();
  const [closeEnough, setCloseEnough] = useState(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const sync = () => setCloseEnough(map.getZoom() >= RAISED_MIN_ZOOM);
    sync();
    map.on("zoom", sync);
    return () => {
      map.off("zoom", sync);
    };
  }, [mapRef, mapReady]);
  // Without an outline (a turn too tangled to draw one), the flat arrow stays.
  const hasOutline = data.features.some((feature) => feature.geometry.type === "Polygon");
  const raised = sceneActive && closeEnough && hasOutline;
  // The route ghost is drawn above the scene; it leaves the raised arrow's
  // span alone so the arrow stays white.
  const setArrowSpan = useNavigationSceneStore((s) => s.setArrowSpan);
  const arrowAlong =
    data.features.length > 0 && route ? maneuverStartMeters(route, upcomingIndex) : null;
  useEffect(() => {
    if (!raised || arrowAlong === null) {
      setArrowSpan(null);
      return;
    }
    const spans = maneuverArrowSpans(mode);
    setArrowSpan({ fromAlong: arrowAlong - spans.before, toAlong: arrowAlong + spans.after });
    return () => setArrowSpan(null);
  }, [raised, arrowAlong, mode, setArrowSpan]);
  const flat = raised ? "none" : "visible";

  const group = useMemo<MapLayerGroup>(
    () => ({
      images: { [MANEUVER_ARROW_HEAD_IMAGE_ID]: (map) => addArrowHeadImage(map) },
      sources: { [SOURCE]: { type: "geojson", data } },
      layers: [
        {
          id: CASING,
          type: "line",
          source: SOURCE,
          filter: ["==", ["geometry-type"], "LineString"],
          layout: { visibility: flat, "line-cap": "round", "line-join": "round" },
          paint: { "line-color": CASING_COLOR, "line-width": 9 },
          slot: "route-markers",
          order: 1,
        },
        {
          id: BODY,
          type: "line",
          source: SOURCE,
          filter: ["==", ["geometry-type"], "LineString"],
          layout: { visibility: flat, "line-cap": "round", "line-join": "round" },
          paint: { "line-color": BODY_COLOR, "line-width": 5 },
          slot: "route-markers",
          order: 2,
        },
        {
          id: RAISED,
          type: "fill-extrusion",
          source: SOURCE,
          filter: ["==", ["geometry-type"], "Polygon"],
          layout: { visibility: raised ? "visible" : "none" },
          paint: {
            "fill-extrusion-color": BODY_COLOR,
            "fill-extrusion-base": RAISED_BASE_M,
            "fill-extrusion-height": RAISED_TOP_M,
            // Darker sides, so the white top reads as a raised slab.
            "fill-extrusion-vertical-gradient": true,
          },
          // With the other 3D layers, so buildings in front of it hide it.
          slot: "scene-3d",
          order: 14,
        },
        {
          id: HEAD,
          type: "symbol",
          source: SOURCE,
          filter: ["==", ["geometry-type"], "Point"],
          layout: {
            visibility: flat,
            "icon-image": MANEUVER_ARROW_HEAD_IMAGE_ID,
            "icon-size": 1,
            "icon-allow-overlap": true,
            "icon-rotation-alignment": "map",
            "icon-rotate": ["get", "bearing"],
          },
          slot: "route-markers",
          order: 3,
        },
      ] satisfies SlottedLayer[],
    }),
    [data, flat, raised],
  );
  useMapLayerGroup(group);

  return null;
}

/** Add the 24 px arrowhead image, drawn once from an inline SVG. */
function addArrowHeadImage(map: maplibregl.Map): void {
  if (map.hasImage(MANEUVER_ARROW_HEAD_IMAGE_ID)) return;
  const img = new Image(24, 24);
  img.onload = () => {
    if (!map.hasImage(MANEUVER_ARROW_HEAD_IMAGE_ID)) {
      map.addImage(MANEUVER_ARROW_HEAD_IMAGE_ID, img);
    }
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ARROW_SVG)}`;
}

const ARROW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <path d="M12 2 L20 20 L12 15 L4 20 Z" fill="#ffffff" stroke="#1b1b1b" stroke-width="1.5" stroke-linejoin="round"/>
</svg>`;
