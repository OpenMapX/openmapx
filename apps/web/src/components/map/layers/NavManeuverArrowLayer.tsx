"use client";

import {
  cumulativeDistances,
  guidanceApproachMeters,
  type ManeuverArrowSpans,
  maneuverArrowLine,
  maneuverArrowSpans,
  maneuverArrowTipBearing,
  stepStartMeters,
  upcomingManeuverIndex,
  useNavigationStore,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useMemo } from "react";
import type { MapLayerGroup, SlottedLayer } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";

const SOURCE = "nav-maneuver-arrow-source";
const CASING = "nav-maneuver-arrow-casing";
const BODY = "nav-maneuver-arrow";
const HEAD = "nav-maneuver-arrow-head";
export const MANEUVER_ARROW_HEAD_IMAGE_ID = "nav-maneuver-arrow-head-icon";

const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };
const CASING_COLOR = "#1b1b1b";
const BODY_COLOR = "#ffffff";

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

  const upcomingIndex = route
    ? upcomingManeuverIndex(currentStepIndex ?? 0, route.steps?.length ?? 0)
    : 0;
  const approaching =
    !!route &&
    distanceToNextManeuver !== undefined &&
    distanceToNextManeuver <= guidanceApproachMeters(mode, speedMps ?? 0);

  const data = useMemo(() => {
    if (status !== "navigating" && status !== "rerouting") return EMPTY_FC;
    if (!route || !approaching || route.geometry.length < 2) return EMPTY_FC;
    const step = route.steps[upcomingIndex];
    if (!step?.maneuver || NON_JUNCTION_TYPES.has(step.maneuver.type)) return EMPTY_FC;
    const cum = cumulativeDistances(route.geometry);
    const alongMeters = stepStartMeters(route.steps, upcomingIndex);
    const spans: ManeuverArrowSpans = maneuverArrowSpans(mode);
    const line = maneuverArrowLine(route.geometry, cum, alongMeters, spans);
    if (!line || line.length < 2) return EMPTY_FC;
    const bearing = maneuverArrowTipBearing(line);
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
          geometry: { type: "Point" as const, coordinates: line[line.length - 1] },
        },
      ],
    };
  }, [status, route, upcomingIndex, approaching, mode]);

  const group = useMemo<MapLayerGroup>(
    () => ({
      images: { [MANEUVER_ARROW_HEAD_IMAGE_ID]: (map) => addArrowHeadImage(map) },
      sources: { [SOURCE]: { type: "geojson", data } },
      layers: [
        {
          id: CASING,
          type: "line",
          source: SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": CASING_COLOR, "line-width": 9 },
          slot: "route-markers",
          order: 1,
        },
        {
          id: BODY,
          type: "line",
          source: SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": BODY_COLOR, "line-width": 5 },
          slot: "route-markers",
          order: 2,
        },
        {
          id: HEAD,
          type: "symbol",
          source: SOURCE,
          filter: ["==", ["geometry-type"], "Point"],
          layout: {
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
    [data],
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
