"use client";

import { useNavigationStore } from "@openmapx/core";
import {
  contributorsForField,
  serializeContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useMemo, useRef } from "react";
import type { MapLayerGroup, SlottedLayer } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { buildNavRouteLine, navRouteProgressFraction } from "./navRouteSplit";
import { useMapDynamicLineState } from "./useMapDynamicLineState";

const SOURCE = "transit-nav-walk-source";
const CASING = "transit-nav-walk-casing";
const TRAVELED = "transit-nav-walk-traveled";
const REMAINING = "transit-nav-walk-remaining";
const LAYERS = [TRAVELED, REMAINING, CASING];
const ATTRIBUTION = { complementaryGradientGroups: [LAYERS] };
const TRANSPARENT = "rgba(0,0,0,0)";

/** Walking-mode route treatment without taking ownership of the transit session. */
export function TransitWalkRouteLayer({
  leg,
  legIndex,
}: {
  leg: TripLeg | null;
  legIndex: number;
}) {
  const progress = useNavigationStore((s) => s.transitProgress);
  const geometry = leg?.geometry;
  const line = useMemo(
    () => (geometry ? buildNavRouteLine(geometry.coordinates) : null),
    [geometry],
  );
  // Full native snapshots clone geometry even when the walking path is unchanged.
  const pathKey = useMemo(
    () => JSON.stringify([legIndex, geometry?.coordinates]),
    [legIndex, geometry],
  );
  const lastTrusted = useRef({ pathKey, fraction: 0 });
  if (lastTrusted.current.pathKey !== pathKey) lastTrusted.current = { pathKey, fraction: 0 };
  if (
    progress?.currentLegIndex === legIndex &&
    progress.confidence === "gps" &&
    progress.deviationMeters <= 30
  )
    lastTrusted.current.fraction = progress.fractionAlongLeg;
  const fraction = line
    ? navRouteProgressFraction(line, lastTrusted.current.fraction * line.lengthKm * 1000)
    : 0;
  const group = useMemo<MapLayerGroup | null>(() => {
    if (!leg || !line) return null;
    return {
      sources: {
        [SOURCE]: {
          type: "geojson",
          lineMetrics: true,
          data: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {
                  _mapAttributions: serializeContributors(
                    snapshotContributors(
                      leg.geometry.contributors ?? contributorsForField(leg, "geometry"),
                    ),
                  ),
                },
                geometry: leg.geometry,
              },
            ],
          },
        },
      },
      layers: [
        {
          id: CASING,
          paint: { "line-color": ROUTE_COLORS.casing, "line-width": ROUTE_WIDTHS.nav.casing },
          order: 8,
        },
        {
          id: TRAVELED,
          paint: { "line-color": ROUTE_COLORS.traveled, "line-width": ROUTE_WIDTHS.nav.traveled },
          order: 9,
        },
        {
          id: REMAINING,
          paint: { "line-color": ROUTE_COLORS.active, "line-width": ROUTE_WIDTHS.nav.line },
          order: 10,
        },
      ].map((layer) => ({
        ...layer,
        type: "line",
        source: SOURCE,
        slot: "route-active",
        layout: { "line-cap": "round", "line-join": "round" },
      })) as SlottedLayer[],
    };
  }, [leg, line]);
  useRenderedMapAttributions("transit-navigation-walk", LAYERS, !!group, ATTRIBUTION);
  useMapLayerGroup(group);
  useMapDynamicLineState(
    useMemo(
      () => ({
        paint: {
          [TRAVELED]: {
            "line-gradient": [
              "step",
              ["line-progress"],
              ROUTE_COLORS.traveled,
              fraction,
              TRANSPARENT,
            ],
          },
          [REMAINING]: {
            "line-gradient": [
              "step",
              ["line-progress"],
              TRANSPARENT,
              fraction,
              ROUTE_COLORS.active,
            ],
          },
          [CASING]: {
            "line-gradient": [
              "step",
              ["line-progress"],
              TRANSPARENT,
              fraction,
              ROUTE_COLORS.casing,
            ],
          },
        },
      }),
      [fraction],
    ),
  );
  return null;
}
