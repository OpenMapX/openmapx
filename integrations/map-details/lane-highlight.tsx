"use client";

import {
  cumulativeDistances,
  guidanceApproachMeters,
  guidanceLanesForStep,
  maneuverArrowLine,
  maneuverStartMeters,
  resolveLaneGuidance,
  upcomingManeuverIndex,
  useNavigationStore,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/integration-framework";
import { useEffect, useMemo, useState } from "react";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { PRIMARY_BLUE_HEX } from "@/integration-api/runtime/theme";
import type { MapDetailsWorkerClient } from "./web/worker-client";

const LAYER_ID = "nav-lane-highlight";
/** Route geometry sent to the worker: enough for the 120 m highlight plus the junction cut-back. */
const APPROACH_BEFORE_M = 150;
const HIGHLIGHT_OPACITY = 0.55;

interface Drawn {
  polygons: [number, number][][];
}

/**
 * The recommended lanes of the next maneuver, marked on the road in 3D
 * navigation (immersive navigation spec §9.2). The worker decides whether the
 * engine's lanes and the OSM lanes agree; only then is anything drawn, and the
 * route turns transparent across the highlighted span so the lanes carry it.
 * One request per maneuver, never per frame; anything uncertain draws nothing.
 */
export function LaneHighlight({
  client,
  streetTemplate,
  zoom,
  satellite,
  mode,
  contributors,
}: {
  client: MapDetailsWorkerClient | null;
  streetTemplate: string | null;
  zoom: number;
  satellite: boolean;
  mode: "full" | "navigation";
  contributors: readonly Attribution[];
}): null {
  const sceneActive = useNavigationSceneStore((s) => s.active);
  const setHighlightSpan = useNavigationSceneStore((s) => s.setHighlightSpan);
  const route = useNavigationStore((s) => s.route);
  const navMode = useNavigationStore((s) => s.mode);
  const stepIndex = useNavigationStore((s) => s.progress?.currentStepIndex ?? 0);
  const approaching = useNavigationStore((s) => {
    const progress = s.progress;
    if (!progress) return false;
    return progress.distanceToNextManeuver <= guidanceApproachMeters(s.mode, progress.speedMps);
  });
  const approachWayIds = useNavigationStore((s) => s.approachWayIds);
  const upcoming = route ? upcomingManeuverIndex(stepIndex, route.steps.length) : -1;
  const wayId = approachWayIds?.[upcoming];

  const eligible =
    mode === "navigation" &&
    sceneActive &&
    zoom >= 16 &&
    !!streetTemplate &&
    !satellite &&
    approaching &&
    (navMode === "driving" || navMode === "motorcycle");

  const lanes = useMemo(
    () =>
      route
        ? guidanceLanesForStep(
            route.steps,
            upcoming,
            route.steps[upcoming]?.lanes,
            route.steps[upcoming + 1]?.lanes,
          )
        : undefined,
    [route, upcoming],
  );

  const [drawn, setDrawn] = useState<Drawn | null>(null);

  useEffect(() => {
    if (
      !eligible ||
      !route ||
      !client ||
      !streetTemplate ||
      wayId === undefined ||
      !lanes?.length
    ) {
      setDrawn(null);
      setHighlightSpan(null);
      return;
    }
    const resolved = resolveLaneGuidance(lanes);
    const recommended =
      resolved.preferredLanes.length > 0 ? resolved.preferredLanes : resolved.usableLanes;
    if (recommended.length === 0) return;
    const cum = cumulativeDistances(route.geometry);
    const maneuverAlong = maneuverStartMeters(route, upcoming);
    const approach = maneuverArrowLine(route.geometry, cum, maneuverAlong, {
      before: APPROACH_BEFORE_M,
      after: 0,
    });
    if (!approach || approach.length < 2) return;
    const controller = new AbortController();
    void client
      .laneHighlight(
        {
          streetTemplate,
          wayId,
          approach: approach as [number, number][],
          engineLanes: lanes,
          recommended,
          classes: ["urban", "motorway"],
        },
        controller.signal,
      )
      .then((answer) => {
        if (controller.signal.aborted || !answer?.polygons) return;
        setDrawn({ polygons: answer.polygons });
        setHighlightSpan({
          fromAlong: maneuverAlong - answer.startBeforeManeuver,
          toAlong: maneuverAlong - answer.endBeforeManeuver,
          offsetMeters: answer.laneOffsetMeters,
        });
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      setDrawn(null);
      setHighlightSpan(null);
    };
  }, [eligible, route, client, streetTemplate, wayId, lanes, upcoming, setHighlightSpan]);

  const group = useMemo<MapLayerGroup | null>(
    () =>
      drawn
        ? {
            sources: {
              [LAYER_ID]: {
                type: "geojson",
                data: {
                  type: "FeatureCollection",
                  features: drawn.polygons.map((ring) => ({
                    type: "Feature" as const,
                    properties: {},
                    geometry: { type: "Polygon" as const, coordinates: [ring] },
                  })),
                },
              },
            },
            layers: [
              {
                id: LAYER_ID,
                type: "fill",
                source: LAYER_ID,
                paint: { "fill-color": PRIMARY_BLUE_HEX, "fill-opacity": HIGHLIGHT_OPACITY },
                // Above the street paint and the planning route line (order 1), below
                // the navigation route casing (order 2).
                slot: "route-active",
                order: 1.5,
              },
            ],
          }
        : null,
    [drawn],
  );
  useMapLayerGroup(group);

  const attribution = useMemo(
    () => ({ layerContributors: { [LAYER_ID]: contributors } }),
    [contributors],
  );
  useRenderedMapAttributions("map-details-lane-highlight", [LAYER_ID], drawn !== null, attribution);

  return null;
}
