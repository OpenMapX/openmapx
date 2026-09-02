"use client";

import { useAirQualityStore } from "@integrations/air-quality/store";
import { useBuildingsStore } from "@integrations/overlay-3d-buildings/store";
import { useCyclingStore } from "@integrations/overlay-cycling/store";
import { useEarthquakeStore } from "@integrations/overlay-earthquakes/store";
import type { EnvironmentSensorType } from "@integrations/overlay-environment/store";
import { useEnvironmentStore } from "@integrations/overlay-environment/store";
import { useHikingStore } from "@integrations/overlay-hiking/store";
import { useLiveTransitStore } from "@integrations/overlay-live-transit/store";
import {
  ALL_CATEGORIES as NATURAL_EVENT_CATEGORIES,
  useNaturalEventStore,
} from "@integrations/overlay-natural-events/store";
import type { GibsLayerId } from "@integrations/overlay-satellite/store";
import { GIBS_LAYERS, useSatelliteStore } from "@integrations/overlay-satellite/store";
import type { MeasurementMode } from "@integrations/overlay-tool-measurement/store";
import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { useTrafficStore } from "@integrations/overlay-traffic-tomtom/store";
import { useTransitStore } from "@integrations/overlay-transit/store";
import { useWeatherStore } from "@integrations/overlay-weather/store";
import {
  useWeatherAlertStore,
  ALL_SEVERITIES as WEATHER_ALERT_SEVERITIES,
} from "@integrations/overlay-weather-alerts/store";
import { useWildfireStore } from "@integrations/overlay-wildfires/store";
import { useWinterSportsStore } from "@integrations/overlay-winter-sports/store";
import type { WeatherSubLayer } from "@openmapx/core";
import {
  type BoundingBox,
  CATEGORY_DEFINITIONS,
  type CategoryId,
  createPlace,
  formatStreetLevelRef,
  getOverlayEntry,
  type IsochroneTravelMode,
  idsFromPrimaryOrCoords,
  type LngLat,
  type MapLayer,
  OVERLAY_REGISTRY,
  PANEL,
  type Place,
  parseStreetLevelRef,
  runOverlayTransaction,
  type TravelMode,
  type UnitSystem,
  useCategorySearchStore,
  useDataSourceStore,
  useDirectionsStore,
  useLayerStore,
  useMapStore,
  useOverlayRegistryReady,
  usePlaceStore,
  useSavedPlacesStore,
  useSearchStore,
  useSidebarStore,
  useStreetLevelStore,
} from "@openmapx/core";
import type { TransportMode } from "@openmapx/mobility-core/transit";
import type * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { frameBoundsInstant, jumpToView } from "@/lib/cameraFraming";
import {
  DEEPLINK_UPDATE_EVENT,
  formatBboxParam,
  formatCameraParam,
  formatLabeledPoint,
  formatLngLat,
  formatLngLatList,
  formatScheduleParam,
  type ParsedDeepLink,
  paramsWithoutDeepLink,
  parseDeepLinkSearch,
  setCsvParam,
  splitCsv,
} from "@/lib/deepLink";

type SubscribableStore = {
  subscribe: (listener: () => void) => () => void;
};

const MAP_LAYERS = [
  "default",
  "satellite",
  "terrain",
  "cycling",
] as const satisfies readonly MapLayer[];
const DIRECTION_MODES = [
  "driving",
  "walking",
  "cycling",
  "transit",
] as const satisfies readonly TravelMode[];
const ISO_MODES = [
  "driving",
  "walking",
  "cycling",
] as const satisfies readonly IsochroneTravelMode[];
const UNIT_SYSTEMS = ["metric", "imperial"] as const satisfies readonly UnitSystem[];
const MEASUREMENT_MODES = ["line", "polygon"] as const satisfies readonly MeasurementMode[];
const WEATHER_SUBLAYERS = [
  "radar",
  "temperature",
  "clouds",
  "wind",
  "pressure",
  "precipitation",
] as const satisfies readonly WeatherSubLayer[];
const EARTHQUAKE_TIME_RANGES = ["hour", "day", "week", "month"] as const;
const EARTHQUAKE_COLOR_MODES = ["depth", "recency"] as const;
const WILDFIRE_DAY_RANGES = [1, 2, 3] as const;
const WILDFIRE_SOURCES = ["VIIRS_SNPP_NRT", "MODIS_NRT"] as const;
const ENVIRONMENT_SENSORS = [
  "temperature",
  "humidity",
  "pm25",
  "pm10",
  "pressure",
  "uv",
  "noise",
] as const satisfies readonly EnvironmentSensorType[];
const LIVE_TRANSIT_MODES = [
  "rail",
  "subway",
  "tram",
  "bus",
  "ferry",
  "gondola",
  "funicular",
  "cable_car",
  "monorail",
] as const satisfies readonly TransportMode[];

const OVERLAY_STORES: SubscribableStore[] = [
  useBuildingsStore,
  useAirQualityStore,
  useCyclingStore,
  useEarthquakeStore,
  useEnvironmentStore,
  useHikingStore,
  useLiveTransitStore,
  useNaturalEventStore,
  useSatelliteStore,
  useTrafficStore,
  useTransitStore,
  useWeatherAlertStore,
  useWeatherStore,
  useWildfireStore,
  useWinterSportsStore,
  useStreetLevelStore,
];

const APP_STATE_STORES: SubscribableStore[] = [
  useCategorySearchStore,
  useDataSourceStore,
  useDirectionsStore,
  useLayerStore,
  useMapStore,
  usePlaceStore,
  useSavedPlacesStore,
  useSearchStore,
  useSidebarStore,
  useMeasurementStore,
  useTravelTimeStore,
  ...OVERLAY_STORES,
];

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (!value) return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function finiteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mapBounds(map: maplibregl.Map | null): BoundingBox | null {
  if (!map) return null;
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

function syncMapStoreFromMap(map: maplibregl.Map): void {
  const center = map.getCenter();
  useMapStore.getState().setViewport({
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  });
}

function fitBbox(map: maplibregl.Map, bbox: BoundingBox): void {
  frameBoundsInstant(map, [
    [bbox.west, bbox.south],
    [bbox.east, bbox.north],
  ]);
  syncMapStoreFromMap(map);
}

function overlayIds(): string[] {
  return OVERLAY_REGISTRY.map((entry) => entry.id).sort((a, b) => a.localeCompare(b));
}

function getOverlayState(id: string) {
  return getOverlayEntry(id)?.getState();
}

// A deep link's `ov` param is the clearest possible expression of user
// intent — someone opened (or shared) a URL naming these exact overlays — so
// every write here is tagged "user" and, unlike contextual automation, is
// never restored away later.
function openOverlay(id: string): void {
  runOverlayTransaction(id, { panelOpen: true }, { kind: "user" });
}

function closeOverlay(id: string): void {
  const state = getOverlayState(id);
  if (!state?.panelOpen) return;
  // An open overlay whose userRevision never moved was opened by automation
  // (contextual overlays for the current directions/navigation context), not
  // by the user or an earlier link. A link that doesn't name it is silent
  // about it, not against it: closing it here would register as a user
  // disable and suppress the automation for the rest of that context.
  if (state.userRevision === 0) return;
  runOverlayTransaction(id, { panelOpen: false }, { kind: "user" });
}

function activeOverlayIds(): string[] {
  return overlayIds().filter((id) => {
    const state = getOverlayState(id);
    return Boolean(state?.panelOpen && state.layerVisible);
  });
}

function applyOverlayState(parsed: ParsedDeepLink): void {
  const requested = new Set(parsed.overlays ?? []);
  const settings = parsed.overlaySettings;

  if (settings.weather) requested.add("weather");
  if (settings.sat || settings.date || settings.opacity) requested.add("satellite");
  if (settings.eq) requested.add("earthquakes");
  if (settings.fire) requested.add("wildfires");
  if (settings.neDays || settings.neCat) requested.add("natural-events");
  if (settings.alertSev) requested.add("weather-alerts");
  if (settings.envSensor) requested.add("environment");
  if (settings.sli) requested.add("street-level-imagery");
  if (settings.trail) requested.add("hiking");
  if (settings.winter) requested.add("winter-sports");
  if (settings.cycleAuto) requested.add("cycling");
  if (settings.ltProviders || settings.ltModes || settings.ltCodes || settings.ltVehicle) {
    requested.add("live-transit");
  }

  for (const id of overlayIds()) {
    if (requested.has(id)) {
      openOverlay(id);
    } else {
      closeOverlay(id);
    }
  }
}

function applyOverlaySettings(parsed: ParsedDeepLink): void {
  const settings = parsed.overlaySettings;

  const weather = oneOf(settings.weather, WEATHER_SUBLAYERS);
  if (weather) useWeatherStore.getState().setActiveSubLayer(weather);

  const satelliteLayer = oneOf(settings.sat, GIBS_LAYERS.map((layer) => layer.id) as GibsLayerId[]);
  if (satelliteLayer) useSatelliteStore.getState().setActiveLayer(satelliteLayer);
  if (/^\d{4}-\d{2}-\d{2}$/.test(settings.date)) {
    useSatelliteStore.getState().setDate(settings.date);
  }
  const opacity = finiteNumber(settings.opacity);
  if (opacity !== undefined) useSatelliteStore.getState().setOpacity(clamp(opacity, 0, 1));

  const [eqRange, eqMagnitude, eqColor, eqHeatmap] = settings.eq.split(",");
  const earthquakeRange = oneOf(eqRange, EARTHQUAKE_TIME_RANGES);
  const earthquakeColor = oneOf(eqColor, EARTHQUAKE_COLOR_MODES);
  const earthquakeMagnitude = finiteNumber(eqMagnitude);
  const earthquakeStore = useEarthquakeStore.getState();
  if (earthquakeRange) earthquakeStore.setTimeRange(earthquakeRange);
  if (earthquakeMagnitude !== undefined)
    earthquakeStore.setMinMagnitude(clamp(earthquakeMagnitude, 0, 10));
  if (earthquakeColor) earthquakeStore.setColorMode(earthquakeColor);
  if (eqHeatmap) earthquakeStore.setShowHeatmap(eqHeatmap === "1");

  const [fireDays, fireSource, fireHeatmap] = settings.fire.split(",");
  const wildfireDays = finiteNumber(fireDays);
  const wildfireSource = oneOf(fireSource, WILDFIRE_SOURCES);
  const wildfireStore = useWildfireStore.getState();
  if (wildfireDays !== undefined && WILDFIRE_DAY_RANGES.includes(wildfireDays as 1 | 2 | 3)) {
    wildfireStore.setDayRange(wildfireDays as 1 | 2 | 3);
  }
  if (wildfireSource) wildfireStore.setSource(wildfireSource);
  if (fireHeatmap) wildfireStore.setShowHeatmap(fireHeatmap === "1");

  const naturalDays = finiteNumber(settings.neDays);
  if (naturalDays !== undefined) useNaturalEventStore.getState().setDays(naturalDays);
  const naturalCategories = splitCsv(settings.neCat).filter((id) =>
    (NATURAL_EVENT_CATEGORIES as readonly string[]).includes(id),
  );
  if (naturalCategories.length > 0) {
    useNaturalEventStore.setState({ activeCategories: new Set(naturalCategories) });
  }

  const alertSeverities = splitCsv(settings.alertSev).filter((id) =>
    (WEATHER_ALERT_SEVERITIES as readonly string[]).includes(id),
  );
  if (alertSeverities.length > 0) {
    useWeatherAlertStore.setState({ activeSeverities: new Set(alertSeverities) });
  }

  const environmentSensor = oneOf(settings.envSensor, ENVIRONMENT_SENSORS);
  if (environmentSensor) useEnvironmentStore.getState().setSensorType(environmentSensor);

  if (settings.sli) {
    const ref = parseStreetLevelRef(settings.sli);
    if (ref) useStreetLevelStore.getState().requestImageLoad(ref);
  }

  const trailId = finiteNumber(settings.trail);
  if (trailId !== undefined) useHikingStore.getState().selectTrail(trailId);

  if (settings.winter) useWinterSportsStore.getState().selectFeature(settings.winter);

  if (settings.cycleAuto) useCyclingStore.getState().setAutoEnabled(settings.cycleAuto === "1");

  const liveTransitModes = splitCsv(settings.ltModes).filter((mode) =>
    (LIVE_TRANSIT_MODES as readonly string[]).includes(mode),
  ) as TransportMode[];
  useLiveTransitStore.setState({
    excludedProviders: new Set(splitCsv(settings.ltProviders)),
    excludedModes: new Set(liveTransitModes),
    excludedCodespaces: new Set(splitCsv(settings.ltCodes)),
    selectedVehicleId: settings.ltVehicle || null,
  });
}

function clearPanelState(): void {
  useSidebarStore.getState().closeAll();
  usePlaceStore.getState().setSelectedPlace(null);
  useSearchStore.getState().reset();
  useCategorySearchStore.getState().clearCategory();
  useDataSourceStore.getState().setActiveSource(null);
  const saved = useSavedPlacesStore.getState();
  saved.setActiveTab("lists");
  saved.clearSelectedList();

  const directions = useDirectionsStore.getState();
  directions.close();
  directions.setMode("driving");
  directions.setAvoidHighways(false);
  directions.setAvoidTolls(false);
  directions.setAvoidFerries(false);
  // Units is a persisted global preference (settings panel), not deep-link
  // state — never reset it on navigation, or it would clobber the user's choice.

  useMeasurementStore.getState().deactivate();
  useTravelTimeStore.getState().deactivate();
}

function makePlace(link: ParsedDeepLink["place"]): Place | null {
  if (!link) return null;
  return createPlace({
    ...idsFromPrimaryOrCoords(link.id, link.coords),
    name: link.name,
    address: link.name,
    coordinates: link.coords,
    category: link.category,
    rawCategory: link.rawCategory,
  });
}

function applyPlace(link: ParsedDeepLink["place"], panel?: string): void {
  const place = makePlace(link);
  if (!place) return;

  usePlaceStore.getState().setSelectedPlace(place);
  useSearchStore.getState().setQuery(place.name);

  if (panel === PANEL.PLACE_CARD) {
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  } else {
    useSidebarStore.getState().openSidebar(PANEL.PLACE);
  }
}

function applyDirections(parsed: ParsedDeepLink["directions"]): void {
  if (!parsed) return;
  const directions = useDirectionsStore.getState();

  directions.close();
  const mode = oneOf(parsed.mode, DIRECTION_MODES);
  if (mode) directions.setMode(mode);
  directions.setAvoidHighways(parsed.avoid.includes("highways"));
  directions.setAvoidTolls(parsed.avoid.includes("tolls"));
  directions.setAvoidFerries(parsed.avoid.includes("ferries"));

  const waypoints = parsed.waypoints.slice(0, 10);
  for (let index = 0; index < Math.max(0, waypoints.length - 2); index += 1) {
    directions.addWaypoint(index);
  }
  for (let index = 0; index < waypoints.length; index += 1) {
    const waypoint = waypoints[index];
    directions.setWaypoint(index, waypoint.coords, waypoint.label);
  }
  // Applied after the waypoints exist; an out-of-range index is a store no-op.
  for (const [index, schedule] of Object.entries(parsed.schedules ?? {})) {
    directions.setWaypointSchedule(Number(index), schedule);
  }

  directions.open();
  useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
}

function applyCategory(parsed: ParsedDeepLink["category"]): void {
  if (!parsed) return;
  const store = useCategorySearchStore.getState();
  store.setActiveCategory(parsed.id as CategoryId);
  if (parsed.bbox) store.setSearchBbox(parsed.bbox);
  store.setMapMoved(false);
  const category = CATEGORY_DEFINITIONS.find((item) => item.id === parsed.id);
  useSearchStore.getState().setQuery(category?.label ?? parsed.id);
  useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
}

function applyDataSource(parsed: ParsedDeepLink["dataSource"]): void {
  if (!parsed) return;
  const store = useDataSourceStore.getState();
  store.setActiveSource(parsed.id);
  if (parsed.bbox) store.setSearchBbox(parsed.bbox);
  store.setMapMoved(false);
  if (parsed.itemId) store.selectItem(parsed.id, parsed.itemId);
  useSidebarStore.getState().openSidebar(PANEL.DATASOURCE);
}

function applySaved(parsed: ParsedDeepLink["saved"]): void {
  if (!parsed) return;
  const store = useSavedPlacesStore.getState();
  if (parsed.tab === "lists" || parsed.tab === "labeled") store.setActiveTab(parsed.tab);
  if (parsed.listId) store.selectList(parsed.listId);
  useSidebarStore.getState().openSidebar(PANEL.SAVED);
}

function applyMeasurement(parsed: ParsedDeepLink["measurement"]): void {
  if (!parsed) return;
  const mode = oneOf(parsed.mode, MEASUREMENT_MODES);
  const units = oneOf(parsed.unitSystem, UNIT_SYSTEMS);
  const store = useMeasurementStore.getState();
  if (mode) store.setMode(mode);
  if (units) store.setUnitSystem(units);
  store.activate();
  for (const point of parsed.points) store.addPoint(point);
  if (parsed.finalized) store.finalize();
}

function applyTravelTime(parsed: ParsedDeepLink["travelTime"]): void {
  if (!parsed) return;
  const mode = oneOf(parsed.mode, ISO_MODES);
  const store = useTravelTimeStore.getState();
  if (mode) store.setMode(mode);
  store.activate();
  if (parsed.origin) store.setOrigin(parsed.origin);
  if (parsed.minutes.length > 0) {
    useTravelTimeStore.setState({
      selectedMinutes: parsed.minutes.slice(0, 4).sort((a, b) => a - b),
    });
  }
}

function applyOverlayDeepLink(parsed: ParsedDeepLink): void {
  applyOverlayState(parsed);
  applyOverlaySettings(parsed);
}

/**
 * `overlays: false` applies everything except the overlay part, for a link
 * that arrives before the overlay registry exists; the caller owns replaying
 * applyOverlayDeepLink once it does.
 */
function applyDeepLink(
  parsed: ParsedDeepLink,
  map: maplibregl.Map | null,
  options: { overlays: boolean },
): void {
  if (!parsed.hasDeepLinkParams) return;

  clearPanelState();

  const layer = useLayerStore.getState();
  layer.setActiveLayer(oneOf(parsed.base, MAP_LAYERS) ?? "default");
  layer.setGlobeView(Boolean(parsed.globe));

  if (options.overlays) applyOverlayDeepLink(parsed);

  if (parsed.map && map) {
    jumpToView(map, {
      center: parsed.map.center,
      zoom: parsed.map.zoom,
      bearing: parsed.map.bearing,
      pitch: parsed.map.pitch,
    });
    syncMapStoreFromMap(map);
  } else if (parsed.category?.bbox && map) {
    fitBbox(map, parsed.category.bbox);
  } else if (parsed.dataSource?.bbox && map) {
    fitBbox(map, parsed.dataSource.bbox);
  }

  if (parsed.directions || parsed.panel === PANEL.DIRECTIONS) applyDirections(parsed.directions);
  if (parsed.category || parsed.panel === PANEL.CATEGORY) applyCategory(parsed.category);
  if (parsed.dataSource || parsed.panel === PANEL.DATASOURCE) applyDataSource(parsed.dataSource);
  if (parsed.saved || parsed.panel === PANEL.SAVED) applySaved(parsed.saved);
  if (parsed.place) applyPlace(parsed.place, parsed.panel);
  applyMeasurement(parsed.measurement);
  applyTravelTime(parsed.travelTime);
}

function encodePlace(params: URLSearchParams, place: Place): void {
  params.set("place", place.id);
  params.set("at", formatLngLat(place.coordinates));
  if (place.name) params.set("name", place.name);
  if (place.category) params.set("cat", place.category);
  if (place.rawCategory) params.set("raw", place.rawCategory);
}

function encodeDirections(params: URLSearchParams): void {
  const directions = useDirectionsStore.getState();
  if (!directions.isOpen && useSidebarStore.getState().activeSidebarId !== PANEL.DIRECTIONS) return;

  params.set("panel", PANEL.DIRECTIONS);
  if (directions.mode !== "driving") params.set("mode", directions.mode);

  const avoid = [
    directions.avoidHighways ? "highways" : "",
    directions.avoidTolls ? "tolls" : "",
    directions.avoidFerries ? "ferries" : "",
  ].filter(Boolean);
  setCsvParam(params, "avoid", avoid);

  for (const waypoint of directions.waypoints) {
    if (!waypoint.coords) continue;
    params.append("wp", formatLabeledPoint({ coords: waypoint.coords, label: waypoint.label }));
  }

  const schedule = formatScheduleParam(directions.waypoints);
  if (schedule) params.set("sched", schedule);
}

function encodePanelState(params: URLSearchParams, map: maplibregl.Map | null): void {
  const sidebar = useSidebarStore.getState();
  const place = usePlaceStore.getState().selectedPlace;
  const category = useCategorySearchStore.getState();
  const dataSource = useDataSourceStore.getState();
  const saved = useSavedPlacesStore.getState();
  const fallbackBbox = mapBounds(map);

  if (sidebar.activeSidebarId) params.set("panel", sidebar.activeSidebarId);
  if (sidebar.activeDetailId === PANEL.PLACE_CARD) params.set("panel", PANEL.PLACE_CARD);

  encodeDirections(params);

  if (place) encodePlace(params, place);

  if (category.activeCategory) {
    params.set("panel", PANEL.CATEGORY);
    params.set("categoryId", category.activeCategory);
    const bbox = category.searchBbox ?? fallbackBbox;
    if (bbox) params.set("bbox", formatBboxParam(bbox));
  }

  if (dataSource.activeSource) {
    params.set("panel", PANEL.DATASOURCE);
    params.set("source", dataSource.activeSource);
    if (dataSource.selectedItem?.sourceId === dataSource.activeSource) {
      params.set("item", dataSource.selectedItem.itemId);
    }
    const bbox = dataSource.searchBbox ?? fallbackBbox;
    if (bbox) params.set("bbox", formatBboxParam(bbox));
  }

  if (sidebar.activeSidebarId === PANEL.SAVED) {
    params.set("panel", PANEL.SAVED);
    params.set("savedTab", saved.activeTab);
    if (saved.selectedListId) params.set("list", saved.selectedListId);
  }
}

function encodeToolState(params: URLSearchParams): void {
  const measurement = useMeasurementStore.getState();
  if (measurement.isActive) {
    params.set("measure", measurement.mode);
    if (measurement.unitSystem !== "metric") params.set("measureUnit", measurement.unitSystem);
    if (measurement.points.length > 0)
      params.set("measurePts", formatLngLatList(measurement.points));
    if (measurement.isFinalized) params.set("measureDone", "1");
  }

  const travelTime = useTravelTimeStore.getState();
  if (travelTime.isActive) {
    params.set("iso", travelTime.mode);
    if (travelTime.origin) params.set("isoAt", formatLngLat(travelTime.origin));
    setCsvParam(
      params,
      "isoMins",
      travelTime.selectedMinutes.map((minutes) => String(minutes)),
    );
  }
}

function encodeOverlaySettings(params: URLSearchParams): void {
  const overlays = new Set(activeOverlayIds());
  if (!overlays.size) return;
  setCsvParam(params, "ov", [...overlays]);

  if (overlays.has("weather")) {
    params.set("weather", useWeatherStore.getState().activeSubLayer);
  }

  if (overlays.has("satellite")) {
    const satellite = useSatelliteStore.getState();
    params.set("sat", satellite.activeLayer);
    params.set("date", satellite.date);
    params.set("opacity", String(satellite.opacity));
  }

  if (overlays.has("earthquakes")) {
    const earthquake = useEarthquakeStore.getState();
    params.set(
      "eq",
      [
        earthquake.timeRange,
        earthquake.minMagnitude,
        earthquake.colorMode,
        earthquake.showHeatmap ? "1" : "0",
      ].join(","),
    );
  }

  if (overlays.has("wildfires")) {
    const wildfire = useWildfireStore.getState();
    params.set(
      "fire",
      [wildfire.dayRange, wildfire.source, wildfire.showHeatmap ? "1" : "0"].join(","),
    );
  }

  if (overlays.has("natural-events")) {
    const naturalEvents = useNaturalEventStore.getState();
    if (naturalEvents.days !== null) params.set("neDays", String(naturalEvents.days));
    if (naturalEvents.activeCategories.size !== NATURAL_EVENT_CATEGORIES.length) {
      setCsvParam(params, "neCat", [...naturalEvents.activeCategories]);
    }
  }

  if (overlays.has("weather-alerts")) {
    const alerts = useWeatherAlertStore.getState();
    if (alerts.activeSeverities.size !== WEATHER_ALERT_SEVERITIES.length) {
      setCsvParam(params, "alertSev", [...alerts.activeSeverities]);
    }
  }

  if (overlays.has("environment")) {
    params.set("envSensor", useEnvironmentStore.getState().sensorType);
  }

  const streetLevel = useStreetLevelStore.getState();
  if (overlays.has("street-level-imagery") && streetLevel.activeImage) {
    params.set("sli", formatStreetLevelRef(streetLevel.activeImage));
  }

  const hiking = useHikingStore.getState();
  if (overlays.has("hiking") && hiking.selectedTrailId !== null) {
    params.set("trail", String(hiking.selectedTrailId));
  }

  const winterSports = useWinterSportsStore.getState();
  if (overlays.has("winter-sports") && winterSports.selectedFeatureId) {
    params.set("winter", winterSports.selectedFeatureId);
  }

  const cycling = useCyclingStore.getState();
  if (overlays.has("cycling") && cycling.autoEnabled) params.set("cycleAuto", "1");

  if (overlays.has("live-transit")) {
    const liveTransit = useLiveTransitStore.getState();
    setCsvParam(params, "ltProviders", [...liveTransit.excludedProviders]);
    setCsvParam(params, "ltModes", [...liveTransit.excludedModes]);
    setCsvParam(params, "ltCodes", [...liveTransit.excludedCodespaces]);
    if (liveTransit.selectedVehicleId) params.set("ltVehicle", liveTransit.selectedVehicleId);
  }
}

function encodeCurrentUrl(map: maplibregl.Map | null): string {
  const url = new URL(window.location.href);
  const params = paramsWithoutDeepLink(url.search);
  const mapState = useMapStore.getState();
  const center = map ? ([map.getCenter().lng, map.getCenter().lat] as LngLat) : mapState.center;
  const zoom = map?.getZoom() ?? mapState.zoom;
  const bearing = map?.getBearing() ?? mapState.bearing;
  const pitch = map?.getPitch() ?? mapState.pitch;
  const layer = useLayerStore.getState();

  params.set("map", formatCameraParam({ center, zoom, bearing, pitch }));
  if (layer.activeLayer !== "default") params.set("base", layer.activeLayer);
  if (layer.globeView) params.set("globe", "1");

  encodeOverlaySettings(params);
  encodePanelState(params, map);
  encodeToolState(params);

  const search = params.toString();
  url.search = search ? `?${search}` : "";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function DeepLinkManager() {
  const { mapRef, mapReady } = useMap();
  // The map is ready long before IntegrationProvider has populated the overlay
  // registry from /api/integrations, so a link's overlay part is applied in a
  // second phase once the registry exists.
  const overlaysReady = useOverlayRegistryReady();
  const overlaysReadyRef = useRef(overlaysReady);
  overlaysReadyRef.current = overlaysReady;
  const applyingRef = useRef(false);
  const timeoutRef = useRef<number | null>(null);
  /** A parsed link whose overlay part is still waiting for the registry. */
  const pendingOverlaysRef = useRef<ParsedDeepLink | null>(null);

  const writeUrl = useCallback(() => {
    if (typeof window === "undefined" || applyingRef.current) return;
    // Until the pending overlay part has been applied, the URL is the only
    // place that intent exists. Re-encoding from the current, overlay-less
    // state would silently delete `ov` and every overlay setting.
    if (pendingOverlaysRef.current) return;
    const nextUrl = encodeCurrentUrl(mapRef.current);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  }, [mapRef]);

  useEffect(() => {
    if (!mapReady) return;

    const map = mapRef.current;

    const scheduleWrite = () => {
      if (applyingRef.current) return;
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(writeUrl, 150);
    };

    const applyFromLocation = () => {
      const parsed = parseDeepLinkSearch(window.location.search);
      if (!parsed.hasDeepLinkParams) return;
      const overlaysNow = overlaysReadyRef.current;
      pendingOverlaysRef.current = overlaysNow ? null : parsed;
      applyingRef.current = true;
      try {
        applyDeepLink(parsed, mapRef.current, { overlays: overlaysNow });
      } finally {
        applyingRef.current = false;
      }
      writeUrl();
    };

    applyFromLocation();

    const unsubscribeStores = APP_STATE_STORES.map((store) => store.subscribe(scheduleWrite));
    map?.on("moveend", scheduleWrite);
    window.addEventListener("popstate", applyFromLocation);
    window.addEventListener(DEEPLINK_UPDATE_EVENT, writeUrl);

    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      for (const unsubscribe of unsubscribeStores) unsubscribe();
      map?.off("moveend", scheduleWrite);
      window.removeEventListener("popstate", applyFromLocation);
      window.removeEventListener(DEEPLINK_UPDATE_EVENT, writeUrl);
    };
  }, [mapReady, mapRef, writeUrl]);

  // Second phase: replay the overlay part of a link that arrived before the
  // registry existed. Runs once per pending link — a later metadata refresh
  // re-populates the registry but must not re-apply a link the user has since
  // moved on from.
  useEffect(() => {
    if (!overlaysReady) return;
    const pending = pendingOverlaysRef.current;
    if (!pending) return;
    pendingOverlaysRef.current = null;
    applyingRef.current = true;
    try {
      applyOverlayDeepLink(pending);
    } finally {
      applyingRef.current = false;
    }
    writeUrl();
  }, [overlaysReady, writeUrl]);

  return null;
}
