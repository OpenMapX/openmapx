"use client";

import { useDebouncedCallback, useNavigationStore, useOverlayExclusion } from "@openmapx/core";
import {
  contributorKey,
  contributorsForField,
  contributorsForRecordFields,
  readCapturedContributors,
  readCapturedFieldContributors,
  serializeContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { LiveTransitVehicle } from "@openmapx/mobility-core/transit";
import type { GeoJSONFeatureDiff, GeoJSONSourceDiff, MapLayerMouseEvent } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { EMPTY_FEATURE_COLLECTION, type MapLayerGroup } from "@/integration-api/map/mapLayerGroup";
import {
  loadTransitVehicleMarkers,
  modeColor,
  transitVehicleIconExpression,
} from "@/integration-api/map/transitMarkers";
import { useGeoJsonSourceDataBridge } from "@/integration-api/map/useGeoJsonSourceDataBridge";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useOverlayMinZoom } from "@/integration-api/overlay/overlayZoomGate";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { isFreshVehicleObservation } from "./freshness";
import { LiveTransitPopup, type ParsedVehicle } from "./popup";
import { useLiveTransitStore } from "./store";
import type { LiveTransitSnapshot } from "./types.js";

const SOURCE_ID = "live-transit-source";
const ICON_LAYER = "live-transit-icon";
const LABEL_LAYER = "live-transit-label";
const RING_LAYER = "live-transit-onroute-ring";
// A filter that matches no feature — used to hide the on-route ring when the
// user isn't following a transit itinerary.
const MATCH_NONE: maplibregl.FilterSpecification = ["==", ["get", "tripId"], " "];
const POLL_MS = 15_000;
const MOVE_ANIMATION_MS = 1_100;
const POSITION_EPSILON = 0.00001;

type AlertSeverity = "info" | "warning" | "severe" | "critical";

type VehicleFeature = GeoJSON.Feature<
  GeoJSON.Point,
  {
    _mapAttributions: string;
    _mapFieldAttributions?: string;
    id: string;
    sourceId: string;
    mode: string;
    displayLabel: string;
    secondaryLabel: string;
    routeId: string;
    currentStopId: string;
    bearing: number;
    speedKmh: number | null;
    updatedAt: string;
    alertCount: number;
    alertSeverity: string;
    positionKind: string;
    tripId: string;
  }
> & { id: string };

function severityRank(severity: AlertSeverity): number {
  if (severity === "critical") return 4;
  if (severity === "severe") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function easeInOutCubic(t: number): number {
  if (t < 0.5) return 4 * t * t * t;
  return 1 - (-2 * t + 2) ** 3 / 2;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function lerpMaybe(
  from: number | undefined,
  to: number | undefined,
  t: number,
): number | undefined {
  if (from == null) return to;
  if (to == null) return from;
  return lerp(from, to, t);
}

function interpolateBearing(
  from: number | undefined,
  to: number | undefined,
  t: number,
): number | undefined {
  if (from == null) return to;
  if (to == null) return from;
  const delta = ((to - from + 540) % 360) - 180;
  return (from + delta * t + 360) % 360;
}

/** Prepare receipt ownership once per snapshot update, never inside the animation loop. */
export function prepareVehicleTransition(previous: ParsedVehicle, target: ParsedVehicle) {
  const fields = ["lat", "lng", "bearing", "speed"] as const;
  const same = (
    a: ReturnType<typeof snapshotContributors>,
    b: ReturnType<typeof snapshotContributors>,
  ) =>
    a.length === b.length &&
    a.every((receipt, index) => {
      const other = b[index];
      return other !== undefined && contributorKey(receipt) === contributorKey(other);
    });
  const capture = (start: boolean) => {
    const changes: Record<string, ReturnType<typeof snapshotContributors>> = {};
    for (const field of fields) {
      const from = previous[field];
      const to = target[field];
      // Nullable endpoints are retained rather than interpolated by lerpMaybe.
      if (from == null || from === to) continue;
      const a = contributorsForField(previous, field);
      const b = contributorsForField(target, field);
      const selected = start || to == null ? a : snapshotContributors(a, b);
      if (!same(selected, b)) changes[field] = selected;
    }
    if (!Object.keys(changes).length) return {};
    const displayed = [
      ...new Set(
        Object.values(VEHICLE_MAP_FIELDS)
          .flat()
          .concat(["updatedAt", "secondaryLabel", "codespaceId", "speed"]),
      ),
    ];
    const fieldContributors = {
      ...Object.fromEntries(displayed.map((field) => [field, contributorsForField(target, field)])),
      ...target.fieldContributors,
      ...changes,
    };
    return {
      fieldContributors,
      contributors: snapshotContributors(target.contributors ?? [], ...Object.values(changes)),
    };
  };
  const unchanged =
    previous.fieldContributors === undefined &&
    target.fieldContributors === undefined &&
    same(
      snapshotContributors(previous.contributors ?? []),
      snapshotContributors(target.contributors ?? []),
    );
  const initial = unchanged ? {} : capture(true);
  const blended = unchanged ? {} : capture(false);
  return (progress: number): ParsedVehicle => {
    if (progress >= 1) return target;
    const speed = lerpMaybe(previous.speed, target.speed, progress);
    return {
      ...target,
      ...(progress <= 0 ? initial : blended),
      lat: lerp(previous.lat, target.lat, progress),
      lng: lerp(previous.lng, target.lng, progress),
      bearing: interpolateBearing(previous.bearing, target.bearing, progress),
      speed,
      speedKmh: speed != null ? Math.round(speed * 3.6) : target.speedKmh,
    };
  };
}

function hasPositionChange(previous: ParsedVehicle, next: ParsedVehicle): boolean {
  return (
    Math.abs(previous.lat - next.lat) > POSITION_EPSILON ||
    Math.abs(previous.lng - next.lng) > POSITION_EPSILON
  );
}

function collectVehicleAlerts(
  vehicle: LiveTransitVehicle,
  alerts: LiveTransitSnapshot["alerts"],
): LiveTransitSnapshot["alerts"] {
  return alerts
    .filter((alert) => {
      if (vehicle.routeId && alert.affectedRouteIds.includes(vehicle.routeId)) return true;
      if (vehicle.currentStopId && alert.affectedStopIds.includes(vehicle.currentStopId))
        return true;
      return false;
    })
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function toParsedVehicles(snapshot: LiveTransitSnapshot | null): ParsedVehicle[] {
  if (!snapshot) return [];
  return snapshot.vehicles
    .filter((vehicle) => isFreshVehicleObservation(vehicle.updatedAt))
    .map((vehicle) => ({
      ...vehicle,
      speedKmh: vehicle.speed != null ? Math.round(vehicle.speed * 3.6) : null,
      color: modeColor(vehicle.mode),
      alerts: collectVehicleAlerts(vehicle, snapshot.alerts),
    }));
}

const VEHICLE_MAP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [ICON_LAYER]: ["lat", "lng", "mode", "bearing", "positionKind"],
  [LABEL_LAYER]: ["lat", "lng", "displayLabel"],
  [RING_LAYER]: ["lat", "lng", "tripId"],
};

/** Preserve one shared snapshot in ordinary features, projecting optional field ownership per painted layer. */
export function vehicleMapContributors(feature: {
  properties: Record<string, unknown>;
  layer: { id: string };
}) {
  const fields = readCapturedFieldContributors(feature.properties._mapFieldAttributions);
  return fields === undefined
    ? (readCapturedContributors(feature.properties._mapAttributions) ?? [])
    : contributorsForRecordFields(
        { fieldContributors: fields },
        VEHICLE_MAP_FIELDS[feature.layer.id] ?? [],
      );
}

export function toFeature(vehicle: ParsedVehicle): VehicleFeature {
  return {
    id: vehicle.id,
    type: "Feature",
    geometry: { type: "Point", coordinates: [vehicle.lng, vehicle.lat] },
    properties: {
      _mapAttributions: serializeContributors(
        contributorsForRecordFields(vehicle, [
          "lat",
          "lng",
          "mode",
          "bearing",
          "displayLabel",
          "tripId",
          "positionKind",
        ]),
      ),
      ...(vehicle.fieldContributors === undefined
        ? {}
        : {
            _mapFieldAttributions: JSON.stringify(
              readCapturedFieldContributors(vehicle.fieldContributors),
            ),
          }),
      id: vehicle.id,
      sourceId: vehicle.sourceId,
      mode: vehicle.mode,
      displayLabel: vehicle.displayLabel,
      secondaryLabel: vehicle.secondaryLabel ?? "",
      routeId: vehicle.routeId ?? "",
      currentStopId: vehicle.currentStopId ?? "",
      bearing: vehicle.bearing ?? 0,
      speedKmh: vehicle.speedKmh,
      updatedAt: vehicle.updatedAt,
      alertCount: vehicle.alerts.length,
      alertSeverity: vehicle.alerts[0]?.severity ?? "",
      positionKind: vehicle.positionKind,
      tripId: vehicle.tripId ?? "",
    },
  };
}

function buildGeoJson(features: Map<string, VehicleFeature>) {
  return {
    type: "FeatureCollection" as const,
    features: [...features.values()],
  };
}

function buildFeatureMap(vehicles: ParsedVehicle[]): Map<string, VehicleFeature> {
  return new Map(vehicles.map((vehicle) => [vehicle.id, toFeature(vehicle)]));
}

function buildSourceDiff(
  previous: Map<string, VehicleFeature>,
  next: Map<string, VehicleFeature>,
): GeoJSONSourceDiff | null {
  const remove: Array<string | number> = [];
  const add: VehicleFeature[] = [];
  const update: GeoJSONFeatureDiff[] = [];

  for (const id of previous.keys()) {
    if (!next.has(id)) remove.push(id);
  }

  for (const [id, feature] of next) {
    const previousFeature = previous.get(id);
    if (previousFeature) {
      update.push({
        id,
        newGeometry: feature.geometry,
        addOrUpdateProperties: Object.entries(feature.properties).map(([key, value]) => ({
          key,
          value,
        })),
      });
    } else {
      add.push(feature);
    }
  }

  if (remove.length === 0 && add.length === 0 && update.length === 0) return null;

  return {
    ...(remove.length > 0 ? { remove } : {}),
    ...(add.length > 0 ? { add } : {}),
    ...(update.length > 0 ? { update } : {}),
  };
}

function liveTransitGroup(minZoom: number, activeTripIds: readonly string[]): MapLayerGroup {
  return {
    sources: {
      [SOURCE_ID]: { type: "geojson", data: EMPTY_FEATURE_COLLECTION, promoteId: "id" },
    },
    // Registers every mode's marker; the bus marker doubles as the fallback icon.
    images: { "tv-bus": loadTransitVehicleMarkers },
    layers: [
      // On-route highlight ring, drawn beneath the vehicle icons, for the
      // vehicles on the itinerary the user is following.
      {
        id: RING_LAYER,
        minzoom: minZoom,
        type: "circle",
        source: SOURCE_ID,
        filter:
          activeTripIds.length > 0
            ? ["in", ["get", "tripId"], ["literal", activeTripIds]]
            : MATCH_NONE,
        slot: "overlay-points",
        order: 14,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 12, 14, 18],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#111827",
          "circle-stroke-width": 3,
        },
      },
      {
        id: ICON_LAYER,
        minzoom: minZoom,
        type: "symbol",
        source: SOURCE_ID,
        slot: "overlay-markers",
        order: 9,
        layout: {
          "icon-image": transitVehicleIconExpression() as maplibregl.ExpressionSpecification,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.42, 8, 0.68, 12, 0.95],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
        },
        paint: {
          // Schedule-interpolated positions (MOTIS map/trips) are shown dimmer
          // than genuine GPS observations to signal they are estimated.
          "icon-opacity": [
            "case",
            ["==", ["get", "positionKind"], "interpolated"],
            0.55,
            1,
          ] as maplibregl.ExpressionSpecification,
        },
      },
      {
        id: LABEL_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        minzoom: Math.max(9, minZoom),
        slot: "overlay-markers",
        order: 10,
        layout: {
          "text-field": ["get", "displayLabel"],
          "text-size": 11,
          "text-offset": [0, 1.8],
          "text-anchor": "top",
          "text-optional": true,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": "#1f2937",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.5,
        },
      },
    ],
  };
}

function collectFilterOptions(vehicles: ParsedVehicle[]) {
  return {
    providers: new Set(vehicles.map((vehicle) => vehicle.sourceId)),
    modes: new Set(vehicles.map((vehicle) => vehicle.mode)),
    codespaces: new Set(
      vehicles
        .map((vehicle) => vehicle.codespaceId)
        .filter((value): value is string => Boolean(value)),
    ),
  };
}

function vehicleMatchesFilters(
  vehicle: ParsedVehicle,
  excludedProviders: Set<string>,
  excludedModes: Set<string>,
  excludedCodespaces: Set<string>,
): boolean {
  if (excludedProviders.has(vehicle.sourceId)) return false;
  if (excludedModes.has(vehicle.mode)) return false;
  if (vehicle.codespaceId && excludedCodespaces.has(vehicle.codespaceId)) return false;
  return true;
}

export function LiveTransitLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  // Declared in this integration's manifest, the same gate the layer selector
  // applies: below it we stop polling and clear the vehicles, so a
  // country-sized viewport can't accumulate thousands of markers.
  const minFetchZoom = useOverlayMinZoom("live-transit");
  const env = useEnv();
  const layerVisible = useLiveTransitStore((s) => s.layerVisible);
  useRenderedMapAttributions("live-transit", [ICON_LAYER, LABEL_LAYER, RING_LAYER], layerVisible, {
    resolveFeatureContributors: vehicleMapContributors,
  });
  const excludedProviders = useLiveTransitStore((s) => s.excludedProviders);
  const excludedModes = useLiveTransitStore((s) => s.excludedModes);
  const excludedCodespaces = useLiveTransitStore((s) => s.excludedCodespaces);
  const setLoading = useLiveTransitStore((s) => s.setLoading);
  const setVehicleCounts = useLiveTransitStore((s) => s.setVehicleCounts);
  const setLastUpdated = useLiveTransitStore((s) => s.setLastUpdated);
  const setAvailableFilters = useLiveTransitStore((s) => s.setAvailableFilters);
  const resetSnapshotMeta = useLiveTransitStore((s) => s.resetSnapshotMeta);
  const selectVehicle = useLiveTransitStore((s) => s.selectVehicle);

  useOverlayExclusion("live-transit", layerVisible);

  // Trip ids of the itinerary the user is currently following, so the vehicle
  // they are riding (and the ones they are heading for) get a highlight ring.
  const navKind = useNavigationStore((s) => s.kind);
  const navStatus = useNavigationStore((s) => s.status);
  const navItinerary = useNavigationStore((s) => s.itinerary);
  const activeTripIds = useMemo(
    () =>
      navKind === "transit" && navStatus !== "idle"
        ? (navItinerary?.legs ?? [])
            .map((leg) => leg.tripId)
            .filter((id): id is string => Boolean(id))
        : [],
    [navKind, navStatus, navItinerary],
  );

  const [snapshot, setSnapshot] = useState<LiveTransitSnapshot | null>(null);
  const [renderVehicles, setRenderVehicles] = useState<ParsedVehicle[]>([]);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const [popupContent, setPopupContent] = useState<{
    container: HTMLElement;
    vehicle: ParsedVehicle;
  } | null>(null);
  const popupVehicleIdRef = useRef<string | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const renderVehiclesRef = useRef<ParsedVehicle[]>([]);
  const sourceFeaturesRef = useRef<Map<string, VehicleFeature>>(new Map());
  const { publish: publishGeoJson, beginRequest } = useGeoJsonSourceDataBridge({
    mapRef,
    mapReady,
    styleVersion,
    visible: layerVisible,
  });
  const parsedVehicles = useMemo(() => toParsedVehicles(snapshot), [snapshot]);
  const filteredVehicles = useMemo(
    () =>
      parsedVehicles.filter((vehicle) =>
        vehicleMatchesFilters(vehicle, excludedProviders, excludedModes, excludedCodespaces),
      ),
    [excludedCodespaces, excludedModes, excludedProviders, parsedVehicles],
  );

  const cancelAnimation = useCallback(() => {
    if (animationFrameRef.current != null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const commitRenderVehicles = useCallback((vehicles: ParsedVehicle[]) => {
    renderVehiclesRef.current = vehicles;
    setRenderVehicles(vehicles);
  }, []);

  const updateSourceData = useCallback(
    (vehicles: ParsedVehicle[]) => {
      const map = mapRef.current;
      if (!map) return;

      const nextFeatures = buildFeatureMap(vehicles);
      const previousFeatures = sourceFeaturesRef.current;
      const data = buildGeoJson(nextFeatures);

      if (previousFeatures.size === 0) {
        publishGeoJson([{ sourceId: SOURCE_ID, data }]);
        sourceFeaturesRef.current = nextFeatures;
        return;
      }

      const diff = buildSourceDiff(previousFeatures, nextFeatures);
      if (!diff) return;

      publishGeoJson([{ sourceId: SOURCE_ID, data, update: diff }]);
      sourceFeaturesRef.current = nextFeatures;
    },
    [mapRef, publishGeoJson],
  );

  const fetchSnapshot = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !layerVisible) return;
    const request = beginRequest();

    if (map.getZoom() < minFetchZoom) {
      cancelAnimation();
      setLoading(false);
      setSnapshot({ vehicles: [], alerts: [] });
      commitRenderVehicles([]);
      return;
    }

    const bounds = map.getBounds();
    const url =
      `${env.apiUrl}/api/integrations/overlay-live-transit/snapshot` +
      `?south=${bounds.getSouth()}&west=${bounds.getWest()}` +
      `&north=${bounds.getNorth()}&east=${bounds.getEast()}`;

    setLoading(true);
    try {
      const res = await fetch(url, { signal: request.signal });
      if (!request.isCurrent() || !res.ok) return;
      const data = (await res.json()) as LiveTransitSnapshot;
      if (!request.isCurrent()) return;
      setSnapshot(data);
      setLastUpdated(Date.now());
    } catch {
      // silent
    } finally {
      if (request.isLatest()) setLoading(false);
    }
  }, [
    beginRequest,
    cancelAnimation,
    commitRenderVehicles,
    env.apiUrl,
    layerVisible,
    mapRef,
    minFetchZoom,
    setLastUpdated,
    setLoading,
  ]);

  const debouncedFetchSnapshot = useDebouncedCallback(fetchSnapshot, 250);

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const feature = e.features?.[0];
      if (!feature) return;
      const map = mapRef.current;
      if (!map) return;

      const vehicleId = String(feature.properties?.id ?? "");
      const vehicle = renderVehiclesRef.current.find((candidate) => candidate.id === vehicleId);
      if (!vehicle) return;

      const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
      popupRef.current?.remove();
      popupVehicleIdRef.current = vehicleId;

      const container = document.createElement("div");
      const popup = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "320px",
        className: "omx-popup",
        offset: 16,
      })
        .setLngLat(coords)
        .setDOMContent(container)
        .addTo(map);

      popup.on("close", () => {
        if (popupRef.current !== popup) return;
        popupVehicleIdRef.current = null;
        popupRef.current = null;
        setPopupContent(null);
        selectVehicle(null);
      });
      popupRef.current = popup;
      setPopupContent({ container, vehicle });
      selectVehicle(vehicleId);
    },
    [mapRef, selectVehicle],
  );

  useEffect(() => {
    if (!popupVehicleIdRef.current || !popupRef.current) return;

    const vehicle = renderVehicles.find((candidate) => candidate.id === popupVehicleIdRef.current);
    if (!vehicle) {
      popupRef.current.remove();
      popupVehicleIdRef.current = null;
      selectVehicle(null);
      return;
    }

    popupRef.current.setLngLat([vehicle.lng, vehicle.lat]);
    setPopupContent((held) => (held ? { ...held, vehicle } : null));
  }, [renderVehicles, selectVehicle]);

  useEffect(() => {
    cancelAnimation();

    if (!layerVisible) {
      commitRenderVehicles([]);
      return;
    }

    const previous = renderVehiclesRef.current;
    if (previous.length === 0 || filteredVehicles.length === 0) {
      commitRenderVehicles(filteredVehicles);
      return;
    }

    const previousById = new Map(previous.map((vehicle) => [vehicle.id, vehicle]));
    const shouldAnimate = filteredVehicles.some((vehicle) => {
      const prev = previousById.get(vehicle.id);
      return prev ? hasPositionChange(prev, vehicle) : false;
    });

    if (!shouldAnimate) {
      commitRenderVehicles(filteredVehicles);
      return;
    }

    const transitions = filteredVehicles.map((target) => {
      const previous = previousById.get(target.id);
      return previous ? prepareVehicleTransition(previous, target) : () => target;
    });
    const start = performance.now();

    const step = (now: number) => {
      const progress = Math.min((now - start) / MOVE_ANIMATION_MS, 1);
      const eased = easeInOutCubic(progress);
      const nextFrame = transitions.map((transition) => transition(eased));

      commitRenderVehicles(nextFrame);

      if (progress < 1) {
        animationFrameRef.current = window.requestAnimationFrame(step);
      } else {
        animationFrameRef.current = null;
        commitRenderVehicles(filteredVehicles);
      }
    };

    animationFrameRef.current = window.requestAnimationFrame(step);

    return () => {
      cancelAnimation();
    };
  }, [cancelAnimation, commitRenderVehicles, filteredVehicles, layerVisible]);

  useMapLayerGroup(
    useMemo(
      () => (layerVisible ? liveTransitGroup(minFetchZoom, activeTripIds) : null),
      [activeTripIds, layerVisible, minFetchZoom],
    ),
  );

  useEffect(() => {
    if (!mapReady || layerVisible) return;
    cancelAnimation();
    popupRef.current?.remove();
    popupVehicleIdRef.current = null;
    sourceFeaturesRef.current = new Map();
    setSnapshot(null);
    commitRenderVehicles([]);
    selectVehicle(null);
    resetSnapshotMeta();
  }, [
    cancelAnimation,
    commitRenderVehicles,
    layerVisible,
    mapReady,
    resetSnapshotMeta,
    selectVehicle,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    const handleMouseEnter = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = "";
    };

    map.on("click", ICON_LAYER, handleClick);
    map.on("mouseenter", ICON_LAYER, handleMouseEnter);
    map.on("mouseleave", ICON_LAYER, handleMouseLeave);
    INTERACTIVE_LAYER_IDS.add(ICON_LAYER);
    return () => {
      map.off("click", ICON_LAYER, handleClick);
      map.off("mouseenter", ICON_LAYER, handleMouseEnter);
      map.off("mouseleave", ICON_LAYER, handleMouseLeave);
      INTERACTIVE_LAYER_IDS.delete(ICON_LAYER);
    };
  }, [handleClick, layerVisible, mapReady, mapRef]);

  // A recreated source starts empty; the data bridge republishes the full
  // collection into it before any further diff, so the last published features
  // stay a valid base for the next incremental update.
  useEffect(() => {
    updateSourceData(renderVehicles);
  }, [renderVehicles, updateSourceData]);

  useEffect(() => {
    const filters = collectFilterOptions(parsedVehicles);
    setAvailableFilters(filters);
    setVehicleCounts(parsedVehicles.length, filteredVehicles.length);
  }, [filteredVehicles.length, parsedVehicles, setAvailableFilters, setVehicleCounts]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !layerVisible) return;

    void fetchSnapshot();
    map.on("moveend", debouncedFetchSnapshot);
    const timer = window.setInterval(() => {
      void fetchSnapshot();
    }, POLL_MS);

    return () => {
      map.off("moveend", debouncedFetchSnapshot);
      window.clearInterval(timer);
    };
  }, [debouncedFetchSnapshot, fetchSnapshot, layerVisible, mapReady, mapRef]);

  useEffect(() => {
    return () => {
      cancelAnimation();
    };
  }, [cancelAnimation]);

  return popupContent
    ? createPortal(<LiveTransitPopup vehicle={popupContent.vehicle} />, popupContent.container)
    : null;
}
