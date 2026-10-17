"use client";

import { routeColor, usePlaceStore, useRouteLive, useTransitRoute } from "@openmapx/core";
import {
  contributorsForField,
  serializeContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { useMemo } from "react";
import type { MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { PRIMARY_BLUE_HEX } from "@/integration-api/runtime/theme";

const SOURCE_ID = "vehicle-live-source";
const LAYER_ID = "vehicle-live-layer";

type RouteLive = NonNullable<ReturnType<typeof useRouteLive>["data"]>;
type TransitRoute = ReturnType<typeof useTransitRoute>["data"];

function vehicleLiveGroup(vehicles: RouteLive["vehicles"], route: TransitRoute): MapLayerGroup {
  return {
    sources: {
      [SOURCE_ID]: {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: vehicles.map((v) => ({
            type: "Feature" as const,
            properties: {
              _mapAttributions: serializeContributors(
                snapshotContributors(
                  v.contributors ?? [],
                  route ? contributorsForField(route, route.color ? "color" : "mode") : [],
                ),
              ),
              id: v.id,
              label: v.label ?? "",
            },
            geometry: { type: "Point" as const, coordinates: [v.lng, v.lat] },
          })),
        },
      },
    },
    layers: [
      {
        id: LAYER_ID,
        type: "circle",
        source: SOURCE_ID,
        slot: "overlay-points",
        order: 21,
        paint: {
          "circle-radius": 10,
          "circle-color": routeColor(route, PRIMARY_BLUE_HEX),
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.95,
        },
      },
    ],
  };
}

export function VehicleLiveLayer() {
  const activeRouteId = usePlaceStore((s) => s.activeRouteId);
  const { data: liveData } = useRouteLive(activeRouteId);
  const { data: route } = useTransitRoute(activeRouteId);
  const vehicles = activeRouteId ? liveData?.vehicles : undefined;

  useRenderedMapAttributions("transit-vehicle-live", [LAYER_ID], Boolean(activeRouteId));
  useMapLayerGroup(
    useMemo(() => (vehicles?.length ? vehicleLiveGroup(vehicles, route) : null), [vehicles, route]),
  );

  return null;
}
