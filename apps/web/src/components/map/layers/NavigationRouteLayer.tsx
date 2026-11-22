"use client";

import { useNavigationStore } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import {
  EMPTY_FEATURE_COLLECTION,
  type MapLayerGroup,
  type SlottedLayer,
} from "@/integration-api/map/mapLayerGroup";
import { useNavigationSceneStore } from "@/integration-api/map/navigationScene";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useNavRouteWidthLatitude } from "@/lib/navigation/useNavRouteWidthLatitude";
import { navRouteWidths, ROUTE_COLORS, ROUTE_WIDTHS } from "@/lib/routeStyle";
import { buildNavRouteLine, navRouteProgressFraction } from "./navRouteSplit";
import {
  routeGeometryFeatures,
  routeSegmentLayerId,
  routeSegmentProgress,
} from "./routeGeometryFeatures";
import type { DynamicLineState } from "./useMapDynamicLineState";
import { useMapDynamicLineState } from "./useMapDynamicLineState";

const SOURCE = "nav-route-source";
const TRAVELED = "nav-route-traveled";
export const NAV_ROUTE_REMAINING_LAYER_ID = "nav-route-remaining";
const REMAINING_CASING = "nav-route-remaining-casing";
// A faint copy of the remaining route above the 3D scene, so the part hidden
// behind buildings still shows through during 3D navigation.
const REMAINING_GHOST = "nav-route-remaining-ghost";
const GHOST_OPACITY = 0.35;

const ALT_SOURCE = "nav-route-alts-source";
const ALT = "nav-route-alts";
const PROPOSED = "nav-route-proposed";
const TRANSPARENT = "rgba(0,0,0,0)";

/**
 * A `step` progress gradient: `before` up to `progress`, then `after`, with
 * the `[from, to]` span (local fractions) transparent when given — the lane
 * highlight carries the route there instead.
 */
function progressGradient(
  before: string,
  progress: number,
  after: string,
  span: { from: number; to: number } | null,
): maplibregl.ExpressionSpecification {
  const plain = ["step", ["line-progress"], before, progress, after];
  if (!span || span.to <= progress || span.to <= span.from) {
    return plain as maplibregl.ExpressionSpecification;
  }
  if (span.from <= progress) {
    return [
      "step",
      ["line-progress"],
      before,
      progress,
      TRANSPARENT,
      span.to,
      after,
    ] as maplibregl.ExpressionSpecification;
  }
  return [
    "step",
    ["line-progress"],
    before,
    progress,
    after,
    span.from,
    TRANSPARENT,
    span.to,
    after,
  ] as maplibregl.ExpressionSpecification;
}

export function NavigationRouteLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const status = useNavigationStore((s) => s.status);
  const route = useNavigationStore((s) => s.route);
  const routes = useNavigationStore((s) => s.routes);
  const activeRouteIndex = useNavigationStore((s) => s.activeRouteIndex);
  const fasterRoute = useNavigationStore((s) => s.fasterRoute);
  const progress = useNavigationStore((s) => s.progress);
  const sceneActive = useNavigationSceneStore((s) => s.active);
  const highlightSpan = useNavigationSceneStore((s) => s.highlightSpan);
  const arrowSpan = useNavigationSceneStore((s) => s.arrowSpan);
  const widthLatitude = useNavRouteWidthLatitude();
  const widths = useMemo(() => navRouteWidths(widthLatitude), [widthLatitude]);
  // Cache the turf line + total length per route so the per-fix update below
  // doesn't re-walk the whole geometry every time the user moves.
  const navLine = useMemo(() => (route ? buildNavRouteLine(route.geometry) : null), [route]);

  // Upload captured geometry once per route; progress changes only paint.
  const activeFeatures = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: status === "idle" || !route ? [] : routeGeometryFeatures(route, {}),
    }),
    [status, route],
  );
  const gradientGroups = useMemo(
    () =>
      activeFeatures.features.map((_, index) =>
        [
          TRAVELED,
          NAV_ROUTE_REMAINING_LAYER_ID,
          REMAINING_CASING,
          // Only while it exists: the tracker ignores a group whose members are
          // not all live line layers.
          ...(sceneActive ? [REMAINING_GHOST] : []),
        ].map((id) => routeSegmentLayerId(id, index)),
      ),
    [activeFeatures, sceneActive],
  );
  useRenderedMapAttributions(
    "nav-route",
    [...gradientGroups.flat(), ALT, PROPOSED],
    status !== "idle",
    {
      // Every group draws exactly one captured span. Its traveled/remaining
      // alpha union covers the span, including before/after its progress interval.
      complementaryGradientGroups: gradientGroups,
    },
  );

  // Where along the line (as a `line-progress` fraction, not a naive
  // geodesic ratio — see navRouteSplit.ts) the traveled/remaining boundary
  // sits. This is the only thing that changes per GPS fix.
  const progressFraction = useMemo(
    () => (navLine ? navRouteProgressFraction(navLine, progress?.alongMeters ?? 0) : 0),
    [navLine, progress?.alongMeters],
  );

  // `step`, not `interpolate`: MapLibre's line renderer only sizes the
  // gradient texture from the line's actual on-screen length and samples it
  // with `gl.NEAREST` when the expression is a step interpolant
  // (`stepInterpolant` in `line_style_layer.ts`). An `interpolate` gradient
  // always uses a flat 256px texture with linear filtering, which would
  // quantize and blur the traveled/remaining boundary into a visible ramp
  // instead of the hard edge the driver sees today.
  const dynamicState = useMemo<DynamicLineState>(() => {
    const paint: NonNullable<DynamicLineState["paint"]> = {};
    const toLocal = (feature: (typeof activeFeatures.features)[number], fraction: number): number =>
      routeSegmentProgress(
        feature.properties,
        navLine?.mercatorCumulative ?? [],
        navLine?.mercatorTotal ?? 0,
        fraction,
      );
    activeFeatures.features.forEach((feature, index) => {
      const localProgress = toLocal(feature, progressFraction);
      const span =
        highlightSpan &&
        navLine &&
        (highlightSpan.route === undefined || highlightSpan.route === route)
          ? {
              from: toLocal(feature, navRouteProgressFraction(navLine, highlightSpan.fromAlong)),
              to: toLocal(feature, navRouteProgressFraction(navLine, highlightSpan.toAlong)),
            }
          : null;
      paint[routeSegmentLayerId(TRAVELED, index)] = {
        "line-gradient": progressGradient(ROUTE_COLORS.traveled, localProgress, TRANSPARENT, null),
      };
      paint[routeSegmentLayerId(NAV_ROUTE_REMAINING_LAYER_ID, index)] = {
        "line-gradient": progressGradient(TRANSPARENT, localProgress, ROUTE_COLORS.active, span),
      };
      paint[routeSegmentLayerId(REMAINING_CASING, index)] = {
        "line-gradient": progressGradient(TRANSPARENT, localProgress, ROUTE_COLORS.casing, span),
      };
      if (sceneActive) {
        // The ghost keeps covering the lane highlight's span, except where the
        // raised arrow stands: drawn above the scene, its tint would turn the
        // white arrow blue, and the arrow marks the route there. Where the two
        // spans overlap neither the route nor the ghost paints, so the
        // attribution union has a gap there; that only ever over-credits.
        const ghostSpan =
          arrowSpan && navLine
            ? {
                from: toLocal(feature, navRouteProgressFraction(navLine, arrowSpan.fromAlong)),
                to: toLocal(feature, navRouteProgressFraction(navLine, arrowSpan.toAlong)),
              }
            : null;
        paint[routeSegmentLayerId(REMAINING_GHOST, index)] = {
          "line-gradient": progressGradient(
            TRANSPARENT,
            localProgress,
            ROUTE_COLORS.active,
            ghostSpan,
          ),
        };
      }
    });
    return { paint };
  }, [activeFeatures, navLine, progressFraction, highlightSpan, arrowSpan, sceneActive, route]);

  const altFeatures = useMemo(() => {
    if (status === "idle") return EMPTY_FEATURE_COLLECTION;
    const alts = routes.flatMap((r, i) =>
      i === activeRouteIndex ? [] : routeGeometryFeatures(r, { routeIndex: i, kind: "alt" }),
    );
    const proposed = fasterRoute
      ? routeGeometryFeatures(fasterRoute.route, { kind: "proposed" })
      : [];
    return { type: "FeatureCollection" as const, features: [...alts, ...proposed] };
  }, [status, routes, activeRouteIndex, fasterRoute]);

  // Each layer's slot, not its creation order, puts the alternates beneath the
  // active route. The order values deliberately sit above the ones `RouteLayer`
  // uses in the same two slots: equal values would tie, and a tie is resolved by
  // whichever registered first — the very race the slot registry exists to remove.
  const group = useMemo<MapLayerGroup>(
    () => ({
      sources: {
        [ALT_SOURCE]: { type: "geojson", data: altFeatures },
        // `lineMetrics` is what makes `["line-progress"]` available to the
        // gradients in `dynamicState` above.
        [SOURCE]: { type: "geojson", lineMetrics: true, data: activeFeatures },
      },
      layers: [
        {
          id: ALT,
          type: "line",
          source: ALT_SOURCE,
          filter: ["!=", ["get", "kind"], "proposed"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ROUTE_COLORS.navAlt,
            "line-width": ROUTE_WIDTHS.nav.altLine,
            "line-opacity": 0.55,
          },
          slot: "route-alt",
          order: 2,
        },
        {
          id: PROPOSED,
          type: "line",
          source: ALT_SOURCE,
          filter: ["==", ["get", "kind"], "proposed"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ROUTE_COLORS.proposed,
            "line-width": ROUTE_WIDTHS.nav.altLine,
            "line-dasharray": [2, 1],
          },
          slot: "route-alt",
          order: 4,
        },
        ...activeFeatures.features.flatMap(
          (_, index) =>
            [
              {
                id: routeSegmentLayerId(REMAINING_CASING, index),
                type: "line",
                source: SOURCE,
                filter: ["==", ["get", "geometryPart"], index],
                layout: { "line-cap": "round", "line-join": "round" },
                // `line-color` is the fallback shown for the one tick before the
                // gradient in `dynamicState` lands.
                paint: { "line-color": ROUTE_COLORS.casing, "line-width": widths.casing },
                slot: "route-active",
                order: 2,
              },
              {
                id: routeSegmentLayerId(TRAVELED, index),
                type: "line",
                source: SOURCE,
                filter: ["==", ["get", "geometryPart"], index],
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                  "line-color": ROUTE_COLORS.traveled,
                  "line-width": widths.traveled,
                  "line-opacity": 0.7,
                },
                slot: "route-active",
                order: 3,
              },
              {
                id: routeSegmentLayerId(NAV_ROUTE_REMAINING_LAYER_ID, index),
                type: "line",
                source: SOURCE,
                filter: ["==", ["get", "geometryPart"], index],
                layout: { "line-cap": "round", "line-join": "round" },
                paint: {
                  "line-color": ROUTE_COLORS.active,
                  "line-width": widths.line,
                },
                slot: "route-active",
                order: 4,
              },
              ...(sceneActive
                ? [
                    {
                      id: routeSegmentLayerId(REMAINING_GHOST, index),
                      type: "line",
                      source: SOURCE,
                      filter: ["==", ["get", "geometryPart"], index],
                      layout: { "line-cap": "round", "line-join": "round" },
                      paint: {
                        // Transparent until its progress gradient lands, so the
                        // first frame never paints the travelled part.
                        "line-color": TRANSPARENT,
                        "line-width": widths.line,
                        "line-opacity": GHOST_OPACITY,
                      },
                      slot: "route-ghost",
                      order: 0,
                    } satisfies SlottedLayer,
                  ]
                : []),
            ] satisfies SlottedLayer[],
        ),
      ] satisfies SlottedLayer[],
    }),
    [activeFeatures, altFeatures, widths, sceneActive],
  );
  useMapLayerGroup(group);
  // Must run after `useMapLayerGroup` so its effect fires after the layers
  // it targets exist.
  useMapDynamicLineState(dynamicState);

  // Tap an alternative to switch to it; show a pointer cursor over one.
  // Bound once the map is ready (it is created after this component mounts)
  // and again if the map instance is replaced.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const idx = e.features?.[0]?.properties?.routeIndex;
      if (typeof idx === "number") useNavigationStore.getState().selectRoute(idx);
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
    };
    map.on("click", ALT, onClick);
    map.on("mouseenter", ALT, onEnter);
    map.on("mouseleave", ALT, onLeave);
    return () => {
      map.off("click", ALT, onClick);
      map.off("mouseenter", ALT, onEnter);
      map.off("mouseleave", ALT, onLeave);
    };
  }, [mapRef, mapReady, styleVersion]);

  return null;
}
