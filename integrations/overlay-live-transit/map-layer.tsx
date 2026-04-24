"use client";

import {
  buildIntegrationAttribution,
  combineAttributions,
  escapeHtml,
  sanitizeUrl,
  useDebouncedCallback,
  useIntegrationRegistry,
  useOverlayExclusion,
} from "@openmapx/core";
import type {
  GeoJSONFeatureDiff,
  GeoJSONSource,
  GeoJSONSourceDiff,
  MapLayerMouseEvent,
} from "maplibre-gl";
import maplibregl from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getFirstSymbolLayerId } from "@/components/map/layers/layerStyleUtils";
import { useLayerReanchor } from "@/components/map/layers/useLayerReanchor";
import { useEnv } from "@/lib/EnvProvider";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { useMap } from "@/lib/MapContext";
import {
  loadTransitVehicleMarkers,
  modeColor,
  transitVehicleIconExpression,
} from "@/lib/transitMarkers";
import { useLiveTransitStore } from "./store";
import type { LiveTransitSnapshot, LiveTransitVehicle } from "./types.js";

const SOURCE_ID = "live-transit-source";
const ICON_LAYER = "live-transit-icon";
const LABEL_LAYER = "live-transit-label";
const MIN_FETCH_ZOOM = 6;
const POLL_MS = 15_000;
const MOVE_ANIMATION_MS = 1_100;
const POSITION_EPSILON = 0.00001;

type AlertSeverity = "info" | "warning" | "severe" | "critical";

interface ParsedVehicle extends LiveTransitVehicle {
  speedKmh: number | null;
  color: string;
  alerts: LiveTransitSnapshot["alerts"];
}

type VehicleFeature = GeoJSON.Feature<
  GeoJSON.Point,
  {
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
  }
> & { id: string };

function severityRank(severity: AlertSeverity): number {
  if (severity === "critical") return 4;
  if (severity === "severe") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function severityColor(severity: AlertSeverity): string {
  if (severity === "critical") return "#B91C1C";
  if (severity === "severe") return "#DC2626";
  if (severity === "warning") return "#D97706";
  return "#2563EB";
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
  return snapshot.vehicles.map((vehicle) => ({
    ...vehicle,
    speedKmh: vehicle.speed != null ? Math.round(vehicle.speed * 3.6) : null,
    color: modeColor(vehicle.mode),
    alerts: collectVehicleAlerts(vehicle, snapshot.alerts),
  }));
}

function buildProviderAttribution(registry: ReturnType<typeof useIntegrationRegistry>): string {
  return combineAttributions(
    registry
      .getByDomain("live-transit")
      .map((integration) => buildIntegrationAttribution(integration.dataSources))
      .filter(Boolean),
  );
}

function toFeature(vehicle: ParsedVehicle): VehicleFeature {
  return {
    id: vehicle.id,
    type: "Feature",
    geometry: { type: "Point", coordinates: [vehicle.lng, vehicle.lat] },
    properties: {
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
    },
  };
}

function buildGeoJson(vehicles: ParsedVehicle[]) {
  return {
    type: "FeatureCollection" as const,
    features: vehicles.map(toFeature),
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

function buildPopupHtml(
  vehicle: ParsedVehicle,
  registry: ReturnType<typeof useIntegrationRegistry>,
): string {
  const label = escapeHtml(vehicle.displayLabel);
  const secondary = escapeHtml(vehicle.secondaryLabel ?? "");
  const provider = registry.findDataSource(vehicle.sourceId);
  const providerName = escapeHtml(provider?.name ?? vehicle.sourceId);
  const providerUrl = provider?.url ? sanitizeUrl(provider.url) : "";
  const updatedAt = new Date(vehicle.updatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const details = [
    secondary ? `<div style="font-size:12px;color:#4b5563">${secondary}</div>` : "",
    vehicle.codespaceId
      ? `<div style="font-size:12px;color:#4b5563">Codespace ${escapeHtml(vehicle.codespaceId)}</div>`
      : "",
    vehicle.speedKmh != null && vehicle.speedKmh > 0
      ? `<div style="font-size:12px;color:#4b5563">${vehicle.speedKmh} km/h</div>`
      : "",
    `<div style="font-size:11px;color:#6b7280">Updated ${escapeHtml(updatedAt)}</div>`,
  ]
    .filter(Boolean)
    .join("");

  const alertsHtml =
    vehicle.alerts.length > 0
      ? `<div style="display:flex;flex-direction:column;gap:4px;margin-top:10px">
    ${vehicle.alerts
      .slice(0, 2)
      .map((alert) => {
        const title = escapeHtml(alert.title);
        const tone = severityColor(alert.severity);
        return `<div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#374151">
          <span style="display:inline-flex;align-items:center;justify-content:center;background:${tone};color:#fff;font-weight:700;font-size:10px;border-radius:999px;min-width:20px;height:20px;padding:0 6px">${alert.severity.toUpperCase()}</span>
          <span>${title}</span>
        </div>`;
      })
      .join("")}
  </div>`
      : "";

  const attributionHtml = providerUrl
    ? `<a href="${providerUrl}" target="_blank" rel="noreferrer" style="color:inherit;text-decoration:underline">${providerName}</a>`
    : providerName;

  return `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;min-width:210px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="display:inline-flex;align-items:center;justify-content:center;background:${vehicle.color};color:#fff;font-weight:700;font-size:14px;border-radius:6px;min-width:48px;height:32px;padding:0 10px">${label}</span>
    </div>
    ${details}
    ${alertsHtml}
    <div style="font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:6px;margin-top:8px">
      ${attributionHtml}
    </div>
  </div>`;
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection" as const, features: [] as GeoJSON.Feature[] };
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
  const env = useEnv();
  const registry = useIntegrationRegistry();
  const attributionHtml = useMemo(() => buildProviderAttribution(registry), [registry]);
  const layerVisible = useLiveTransitStore((s) => s.layerVisible);
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
  useLayerReanchor([ICON_LAYER, LABEL_LAYER], layerVisible);

  const [snapshot, setSnapshot] = useState<LiveTransitSnapshot | null>(null);
  const [renderVehicles, setRenderVehicles] = useState<ParsedVehicle[]>([]);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const popupVehicleIdRef = useRef<string | null>(null);
  const layerInitRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const renderVehiclesRef = useRef<ParsedVehicle[]>([]);
  const sourceFeaturesRef = useRef<Map<string, VehicleFeature>>(new Map());
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
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;

      const nextFeatures = buildFeatureMap(vehicles);
      const previousFeatures = sourceFeaturesRef.current;

      if (previousFeatures.size === 0) {
        source.setData(buildGeoJson(vehicles));
        sourceFeaturesRef.current = nextFeatures;
        return;
      }

      const diff = buildSourceDiff(previousFeatures, nextFeatures);
      if (!diff) return;

      source.updateData(diff);
      sourceFeaturesRef.current = nextFeatures;
    },
    [mapRef],
  );

  const fetchSnapshot = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !layerVisible) return;

    if (map.getZoom() < MIN_FETCH_ZOOM) {
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
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as LiveTransitSnapshot;
      setSnapshot(data);
      setLastUpdated(Date.now());
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [
    cancelAnimation,
    commitRenderVehicles,
    env.apiUrl,
    layerVisible,
    mapRef,
    setLastUpdated,
    setLoading,
  ]);

  const debouncedFetchSnapshot = useDebouncedCallback(fetchSnapshot, 250);

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
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

      const popup = new maplibregl.Popup({
        closeButton: true,
        maxWidth: "320px",
        className: "omx-popup",
        offset: 16,
      })
        .setLngLat(coords)
        .setHTML(buildPopupHtml(vehicle, registry))
        .addTo(map);

      popup.on("close", () => {
        popupVehicleIdRef.current = null;
        selectVehicle(null);
      });
      popupRef.current = popup;
      selectVehicle(vehicleId);
    },
    [mapRef, registry, selectVehicle],
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
    popupRef.current.setHTML(buildPopupHtml(vehicle, registry));
  }, [renderVehicles, registry, selectVehicle]);

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

    const start = performance.now();

    const step = (now: number) => {
      const progress = Math.min((now - start) / MOVE_ANIMATION_MS, 1);
      const eased = easeInOutCubic(progress);
      const nextFrame = filteredVehicles.map((target) => {
        const prev = previousById.get(target.id);
        if (!prev) return target;

        const speed = lerpMaybe(prev.speed, target.speed, eased);
        return {
          ...target,
          lat: lerp(prev.lat, target.lat, eased),
          lng: lerp(prev.lng, target.lng, eased),
          bearing: interpolateBearing(prev.bearing, target.bearing, eased),
          speed,
          speedKmh: speed != null ? Math.round(speed * 3.6) : target.speedKmh,
        };
      });

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

  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (!layerVisible) {
      try {
        if (map.getLayer(LABEL_LAYER)) map.removeLayer(LABEL_LAYER);
        if (map.getLayer(ICON_LAYER)) map.removeLayer(ICON_LAYER);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // race during style swaps
      }
      cancelAnimation();
      popupRef.current?.remove();
      popupVehicleIdRef.current = null;
      layerInitRef.current = false;
      sourceFeaturesRef.current = new Map();
      setSnapshot(null);
      commitRenderVehicles([]);
      selectVehicle(null);
      resetSnapshotMeta();
      return;
    }

    if (!map.isStyleLoaded() || layerInitRef.current) return;

    loadTransitVehicleMarkers(map);
    sourceFeaturesRef.current = new Map();
    map.addSource(SOURCE_ID, {
      type: "geojson",
      data: emptyFeatureCollection(),
      promoteId: "id",
      attribution: attributionHtml,
    });

    const beforeLayer = getFirstSymbolLayerId(map);

    map.addLayer(
      {
        id: ICON_LAYER,
        type: "symbol",
        source: SOURCE_ID,
        layout: {
          "icon-image": transitVehicleIconExpression() as maplibregl.ExpressionSpecification,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 5, 0.42, 8, 0.68, 12, 0.95],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
        },
      },
      beforeLayer,
    );

    map.addLayer({
      id: LABEL_LAYER,
      type: "symbol",
      source: SOURCE_ID,
      minzoom: 9,
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
    });

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

    layerInitRef.current = true;

    return () => {
      map.off("click", ICON_LAYER, handleClick);
      map.off("mouseenter", ICON_LAYER, handleMouseEnter);
      map.off("mouseleave", ICON_LAYER, handleMouseLeave);
      INTERACTIVE_LAYER_IDS.delete(ICON_LAYER);
      try {
        if (map.getLayer(LABEL_LAYER)) map.removeLayer(LABEL_LAYER);
        if (map.getLayer(ICON_LAYER)) map.removeLayer(ICON_LAYER);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // race during style swaps
      }
      sourceFeaturesRef.current = new Map();
      layerInitRef.current = false;
    };
  }, [
    attributionHtml,
    cancelAnimation,
    commitRenderVehicles,
    handleClick,
    layerVisible,
    mapReady,
    mapRef,
    resetSnapshotMeta,
    selectVehicle,
    styleVersion,
  ]);

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

  return null;
}
