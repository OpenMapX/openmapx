"use client";

import CloseIcon from "@mui/icons-material/Close";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import EvStationIcon from "@mui/icons-material/EvStation";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MenuIcon from "@mui/icons-material/Menu";
import RouteIcon from "@mui/icons-material/Route";
import ScheduleIcon from "@mui/icons-material/Schedule";
import ShareIcon from "@mui/icons-material/Share";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Snackbar from "@mui/material/Snackbar";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import type { AutocompleteResult, DirectionsResult, LngLat, TravelMode } from "@openmapx/core";
import {
  directionsQueryKey,
  formatDistance,
  formatDuration,
  isApiClientError,
  timeZoneAt,
  tzDiffMinutes,
  tzOffsetLabel,
  useAutocomplete,
  useCapabilities,
  useDebounce,
  useDirections,
  useDirectionsStore,
  useEvDirections,
  useMapStore,
  useMenuStore,
  useOptimizeRoute,
  useScheduledDirections,
  useSession,
  useSettingsStore,
  useSidebarStore,
  useVehicles,
  viewerTimeZone,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForField,
  contributorsForNestedRecordFields,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DetailsView } from "@/components/panels/directions/DetailsView";
import { EvPlanCard } from "@/components/panels/directions/EvPlanCard";
import { EvVehiclePanel } from "@/components/panels/directions/EvVehiclePanel";
import { FlightPanel } from "@/components/panels/directions/FlightPanel";
import { MODES, ModeButton } from "@/components/panels/directions/ModeSelector";
import { RidePanel } from "@/components/panels/directions/RidePanel";
import { RouteCard } from "@/components/panels/directions/RouteCard";
import { RouteOptions } from "@/components/panels/directions/RouteOptions";
import type { RouteArrivalContext } from "@/components/panels/directions/routeArrival";
import { ShareRouteDialog } from "@/components/panels/directions/ShareRouteDialog";
import {
  type TimeMode,
  TimeModePicker,
  toDateTimeLocalString,
} from "@/components/panels/directions/TimeModePicker";
import { TransitChainView } from "@/components/panels/directions/TransitChainView";
import { TransitDetailsView } from "@/components/panels/directions/TransitDetailsView";
import { TransitItineraryCard } from "@/components/panels/directions/TransitRouteView";
import { TripScheduleCard } from "@/components/panels/directions/TripScheduleCard";
import { WaypointList } from "@/components/panels/directions/WaypointList";
import { WaypointScheduleDialog } from "@/components/panels/directions/WaypointScheduleDialog";
import { useExpandOnBackgroundTap, useMobileSheet } from "@/components/panels/sheet/sheetState";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { AttributionDetailsGroup } from "@/components/ui/AttributionDetailsGroup";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import {
  buildEvDirectionsRequest,
  GARAGE_VEHICLE_PREFIX,
  isGarageVehicleId,
} from "@/lib/buildEvDirectionsRequest";
import { shareCurrentUrl } from "@/lib/deepLink";
import { buildScheduleRequest } from "@/lib/directions/scheduleRequest";
import { useForegroundLocation } from "@/lib/mobile/useForegroundLocation";
import { routeAttributions } from "@/lib/routeAttributions";
import { servedAttributions } from "@/lib/servedAttributions";
import { useRouteImpacts } from "./useRouteImpacts";
import { useTransitDirectionsPlan } from "./useTransitDirectionsPlan";

const GROUND_FALLBACK_MODES = ["walking", "cycling", "driving", "motorcycle"] as const;
type GroundFallbackMode = (typeof GROUND_FALLBACK_MODES)[number];

function RouteRecovery({
  failed,
  error,
  onRetry,
  onEditOrigin,
  onEditDestination,
  modes = [],
  onSelectMode,
}: {
  failed: boolean;
  error?: unknown;
  onRetry?: () => void;
  onEditOrigin: () => void;
  onEditDestination: () => void;
  modes?: GroundFallbackMode[];
  onSelectMode: (mode: GroundFallbackMode) => void;
}) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const unavailable = isApiClientError(error) && [502, 503, 504].includes(error.status);
  return (
    <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
      <Typography variant="body2" color={failed ? "error.main" : "text.secondary"}>
        {t(
          failed
            ? unavailable
              ? "routeServiceUnavailable"
              : "routeRequestFailed"
            : "noRoutesFound",
        )}
      </Typography>
      {failed ? (
        <Button size="small" onClick={onRetry} sx={{ mt: 1 }}>
          {tc("retry")}
        </Button>
      ) : (
        <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 1, mt: 1 }}>
          <Button size="small" onClick={onEditOrigin}>
            {t("changeOrigin")}
          </Button>
          <Button size="small" onClick={onEditDestination}>
            {t("changeDestination")}
          </Button>
          {modes.map((mode) => (
            <Button key={mode} size="small" onClick={() => onSelectMode(mode)}>
              {t("tryMode", { mode: t(mode) })}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  );
}

export function DirectionsPanelContent() {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const tp = useTranslations("place");
  const tShare = useTranslations("share");
  const locale = useLocale();
  const fmt = useDateTimeFormat();
  const { snapTo } = useMobileSheet();
  const expandOnBackgroundTap = useExpandOnBackgroundTap();
  const {
    isOpen,
    waypoints,
    mode,
    isEvMode,
    evSocStartPct,
    evSocArrivalMinPct,
    evForceNonExclusive,
    activeRouteIndex,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    bikeProfile,
    bikeHillPreference,
    bikePreferQuietRoads,
    bikePreferSmoothSurfaces,
    bikeSpeedKmh,
    activeItineraryIndex,
    transitDepartureTime,
    transitArrivalTime,
    transitPreferredModes,
    transitRoutePreference,
    transitAccessMode,
    wheelchairRequired,
    maxTransfers,
    transferBuffer,
    requireBikeTransport,
    deutschlandticketOnly,
    timeMode,
    tripTime,
    setTimeMode,
    setTripTime,
    setWaypointSchedule,
    applyWaypointOrder,
    setWaypoint,
    addWaypoint,
    removeWaypoint,
    reorderWaypoints,
    reverseWaypoints,
    setMode,
    setEvMode,
    setEvForceNonExclusive,
    setActiveRouteIndex,
    setTransitItineraries,
    setActiveItineraryIndex,
    setTransitDepartureTime,
    setTransitArrivalTime,
  } = useDirectionsStore();
  const origin = waypoints[0]?.coords ?? null;
  const originLabel = waypoints[0]?.label ?? "";
  const destination = waypoints.at(-1)?.coords ?? null;
  const destinationLabel = waypoints.at(-1)?.label ?? "";
  // Meaningful only when the origin and destination actually keep a
  // different wall clock. Two zones can differ by id (Europe/Berlin vs
  // Europe/Paris) yet share the same UTC offset, in which case the arrival
  // time is byte-identical to before this feature and there is nothing to
  // annotate — so this derives from a non-zero offset difference rather than
  // an id mismatch. Same-offset trips pass null, keeping every same-offset
  // itinerary a strict no-op.
  const destinationTimeZone = useMemo(() => {
    if (!origin || !destination) return null;
    const from = timeZoneAt(origin[1], origin[0]);
    const to = timeZoneAt(destination[1], destination[0]);
    if (!from || !to) return null;
    return tzDiffMinutes(new Date(), from, to) ? to : null;
  }, [origin, destination]);
  // Gate the caption on the resolved label rather than the zone id itself:
  // tzOffsetLabel can still fail on a stale or unrecognised tzid even after
  // destinationTimeZone resolved, in which case the arrival already fell
  // back to the viewer's zone and the caption would otherwise claim a
  // re-zoning that didn't happen.
  const destinationOffsetLabel = useMemo(
    () => (destinationTimeZone ? tzOffsetLabel(new Date(), destinationTimeZone) : null),
    [destinationTimeZone],
  );
  // The start renders in the origin's zone whenever that differs from the
  // viewer's own — otherwise "startTime" would keep rendering in the
  // viewer's zone while "endTime" renders in the destination's, producing a
  // span the two ends disagree about. Same-offset origins pass null, a
  // strict no-op.
  const viewerZone = viewerTimeZone();
  const originTimeZone = useMemo(() => {
    if (!origin) return null;
    const zone = timeZoneAt(origin[1], origin[0]);
    if (!zone) return null;
    return tzDiffMinutes(new Date(), viewerZone, zone) ? zone : null;
  }, [origin, viewerZone]);
  const units = useSettingsStore((s) => s.units);
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  const evVehicleId = useSettingsStore((s) => s.evVehicleId);
  const { data: garageVehicles } = useVehicles();
  const evSocTargetPct = useSettingsStore((s) => s.evSocTargetPct);
  const evPreferredNetworks = useSettingsStore((s) => s.evPreferredNetworks);
  const evAvoidedNetworks = useSettingsStore((s) => s.evAvoidedNetworks);
  const evExclusiveNetworks = useSettingsStore((s) => s.evExclusiveNetworks);
  const evPreferCheaper = useSettingsStore((s) => s.evPreferCheaper);
  const evHomePricePerKwh = useSettingsStore((s) => s.evHomePricePerKwh);
  const evHomeCurrency = useSettingsStore((s) => s.evHomeCurrency);

  const { userLocation } = useMapStore();
  const mapContext = useMapOptional();
  const registry = useIntegrationRegistry();
  const { services: caps } = useCapabilities();
  const queryClient = useQueryClient();
  const optimizeMutation = useOptimizeRoute();

  const [showOptions, setShowOptions] = useState(false);
  const [detailsRouteIndex, setDetailsRouteIndex] = useState<number | null>(null);
  const [transitDetailsIndex, setTransitDetailsIndex] = useState<number | null>(null);
  const [transitTimeMode, setTransitTimeMode] = useState<"now" | "depart" | "arrive">("now");
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  // Driving depart/arrive is kept independent of the transit time state so the
  // two flows never interfere.
  const [scheduleEditIndex, setScheduleEditIndex] = useState<number | null>(null);
  const [focusedField, setFocusedField] = useState<number | null>(null);
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const waypointListRef = useRef<HTMLDivElement>(null);

  const myLocationLabel = t("myLocation");
  const requestFix = useForegroundLocation();
  useEffect(() => {
    if (!isOpen) return;

    let active = true;
    // Through the adapter, so the installed shell answers from the one location
    // producer it already owns rather than opening a second one.
    void requestFix({ maxAgeMs: 0 }).then((result) => {
      if (!active || result.status !== "ok") return;
      if (!useDirectionsStore.getState().isOpen) return;
      const location: LngLat = [result.fix.lng, result.fix.lat];
      useMapStore.getState().setUserLocation(location);
      setWaypoint(0, location, myLocationLabel);
    });

    return () => {
      active = false;
    };
  }, [isOpen, myLocationLabel, setWaypoint, requestFix]);

  const [shareMenuAnchor, setShareMenuAnchor] = useState<HTMLElement | null>(null);
  const [shareRouteDialogOpen, setShareRouteDialogOpen] = useState(false);
  const { data: session } = useSession();

  const handleCopyCurrentView = async () => {
    setShareMenuAnchor(null);
    const result = await shareCurrentUrl();
    if (result === "copied") setSnackbar(tp("linkCopied"));
  };

  const handleShare = (event: React.MouseEvent<HTMLElement>) => {
    if (!session?.user?.id) {
      void handleCopyCurrentView();
      return;
    }
    setShareMenuAnchor(event.currentTarget);
  };

  // Per-waypoint input text (synced from store labels)
  const [inputValues, setInputValues] = useState<string[]>(() => waypoints.map((wp) => wp.label));

  // Sync input values when waypoints change externally
  useEffect(() => {
    setInputValues(waypoints.map((wp) => wp.label));
  }, [waypoints]);

  const isTransitMode = mode === "transit";
  const isFlightMode = mode === "flying";
  // Ride mode still needs the real road route — it draws on the map and gives
  // the panel its trip summary — so it fetches like driving rather than being
  // excluded the way flight mode is. Only the results area differs.
  const isRideMode = mode === "ride";
  const routeMode: TravelMode = isRideMode ? "driving" : mode;
  // Rows that describe driving the route yourself (time picker, avoid options,
  // share, optimize) do not apply when someone else is doing the driving.
  const hidesRouteControls = isFlightMode || isRideMode;
  // Time-aware road modes — Valhalla honors depart/arrive on these; OSRM ignores it.
  const isDrivingTimeMode = mode === "driving" || mode === "motorcycle";

  // Collect all non-null coords for the route query
  const routeWaypoints = useMemo(
    () =>
      waypoints.reduce<LngLat[]>((acc, wp) => {
        if (wp.coords) acc.push(wp.coords);
        return acc;
      }, []),
    [waypoints],
  );
  const allWaypointsFilled = routeWaypoints.length === waypoints.length && waypoints.length >= 2;

  // Road-mode depart/arrive → wall-clock strings for the time-aware engine
  // (Valhalla; OSRM ignores them). Debounced so dragging the picker doesn't
  // refetch per change. Driving + motorcycle only (transit has its own query).
  const debouncedDrivingTime = useDebounce(tripTime, 500);
  const drivingDepartAtStr =
    isDrivingTimeMode && timeMode === "depart" && debouncedDrivingTime instanceof Date
      ? toDateTimeLocalString(debouncedDrivingTime)
      : undefined;
  const drivingArriveByStr =
    isDrivingTimeMode && timeMode === "arrive" && debouncedDrivingTime instanceof Date
      ? toDateTimeLocalString(debouncedDrivingTime)
      : undefined;
  const arrivalContext: RouteArrivalContext | undefined =
    isDrivingTimeMode && timeMode === "now"
      ? {
          kind: "now",
          destinationTimeZone: destination ? timeZoneAt(destination[1], destination[0]) : null,
        }
      : drivingDepartAtStr
        ? {
            kind: "departAt",
            wallClock: drivingDepartAtStr,
            originTimeZone: origin ? timeZoneAt(origin[1], origin[0]) : null,
            destinationTimeZone: destination ? timeZoneAt(destination[1], destination[0]) : null,
          }
        : drivingArriveByStr
          ? {
              kind: "arriveBy",
              wallClock: drivingArriveByStr,
              destinationTimeZone: destination ? timeZoneAt(destination[1], destination[0]) : null,
            }
          : undefined;

  // One of the two ground queries runs at a time: the scheduled endpoint takes
  // over the moment any waypoint carries a constraint, so the two can never
  // split the cache or draw different routes.
  const scheduleRequest = useMemo(
    () =>
      isTransitMode || isFlightMode || isEvMode
        ? null
        : buildScheduleRequest({
            waypoints,
            mode: routeMode,
            timeMode,
            tripTime: debouncedDrivingTime,
            avoidHighways,
            avoidTolls,
            avoidFerries,
            bikeProfile,
            bikeHillPreference,
            bikePreferQuietRoads,
            bikePreferSmoothSurfaces,
            bikeSpeedKmh,
            avoidClosures: avoidIncidents,
            units,
            lang: locale,
          }),
    [
      isTransitMode,
      isFlightMode,
      isEvMode,
      waypoints,
      routeMode,
      timeMode,
      debouncedDrivingTime,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      bikeProfile,
      bikeHillPreference,
      bikePreferQuietRoads,
      bikePreferSmoothSurfaces,
      bikeSpeedKmh,
      avoidIncidents,
      units,
      locale,
    ],
  );
  const scheduledQuery = useScheduledDirections(scheduleRequest);
  const { data: scheduledData } = scheduledQuery;

  const directionsQuery = useDirections({
    waypoints:
      isTransitMode || isFlightMode || isEvMode || scheduleRequest
        ? []
        : allWaypointsFilled
          ? routeWaypoints
          : [],
    mode: routeMode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    bikeProfile,
    bikeHillPreference,
    bikePreferQuietRoads,
    bikePreferSmoothSurfaces,
    bikeSpeedKmh,
    avoidClosures: avoidIncidents,
    units,
    lang: locale,
    departAt: drivingDepartAtStr,
    arriveBy: drivingArriveByStr,
  });
  const { data, isLoading, isError } = directionsQuery;

  const routesForImpact = (scheduleRequest ? scheduledData?.routes : data?.routes) ?? [];
  const fastestRouteIndex = useMemo(() => {
    if (routesForImpact.length === 0) return -1;
    return routesForImpact.reduce(
      (fastestIndex, route, index) =>
        route.duration < routesForImpact[fastestIndex].duration ? index : fastestIndex,
      0,
    );
  }, [routesForImpact]);
  const {
    impacts: routeImpacts,
    unavailableReason: routeImpactUnavailableReason,
    compatibleVehicles: impactVehicles,
    updateAssumptions: handleUpdateAssumptions,
  } = useRouteImpacts({
    routes: routesForImpact,
    destination,
    vehicles: garageVehicles,
    homeElectricityPrice: evHomePricePerKwh,
    homeElectricityCurrency: evHomeCurrency,
  });

  // EV plan query — built identically to RouteLayer's independent request
  // (via the shared `buildEvDirectionsRequest`) so both hit the same cache
  // entry instead of firing two network requests.
  const evRequest = useMemo(
    () =>
      buildEvDirectionsRequest({
        isEvMode,
        waypoints: routeWaypoints,
        allWaypointsFilled,
        vehicleId: evVehicleId,
        garageVehicle:
          evVehicleId && isGarageVehicleId(evVehicleId)
            ? (garageVehicles?.find((v) => v.id === evVehicleId.slice(GARAGE_VEHICLE_PREFIX.length))
                ?.ev ?? null)
            : null,
        socStartPct: evSocStartPct,
        socArrivalMinPct: evSocArrivalMinPct,
        socTargetPct: evSocTargetPct,
        departAt: drivingDepartAtStr,
        avoidHighways,
        avoidTolls,
        avoidFerries,
        avoidClosures: avoidIncidents,
        preferredNetworks: evPreferredNetworks,
        avoidedNetworks: evAvoidedNetworks,
        exclusiveNetworks: evExclusiveNetworks,
        forceNonExclusive: evForceNonExclusive,
        preferCheaper: evPreferCheaper,
        homePricePerKwh: evHomePricePerKwh,
        homeCurrency: evHomeCurrency,
        units,
        lang: locale,
      }),
    [
      isEvMode,
      routeWaypoints,
      allWaypointsFilled,
      evVehicleId,
      garageVehicles,
      evSocStartPct,
      evSocArrivalMinPct,
      evSocTargetPct,
      drivingDepartAtStr,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      avoidIncidents,
      evPreferredNetworks,
      evAvoidedNetworks,
      evExclusiveNetworks,
      evForceNonExclusive,
      evPreferCheaper,
      evHomePricePerKwh,
      evHomeCurrency,
      units,
      locale,
    ],
  );
  const evQuery = useEvDirections(evRequest);
  const { data: evData, isLoading: evLoading, isError: evIsError } = evQuery;

  const {
    isChained: transitIsChained,
    planQuery: transitPlanQuery,
    chainQuery: transitChainQuery,
    itineraries: transitItineraries,
    replanOptions: transitReplanOptions,
    attributions: transitPlanAttributions,
    paging: transitPaging,
  } = useTransitDirectionsPlan({
    enabled: isTransitMode,
    timeMode: transitTimeMode,
    waypoints,
    transitDepartureTime,
    transitArrivalTime,
    transitPreferredModes,
    transitRoutePreference,
    transitAccessMode,
    wheelchairRequired,
    maxTransfers,
    transferBuffer,
    requireBikeTransport,
    bikeHillPreference,
    deutschlandticketOnly,
  });
  const { data: transitChainData } = transitChainQuery;
  const {
    data: transitPlanData,
    isLoading: transitLoading,
    isError: transitError,
  } = transitPlanQuery;

  // Autocomplete for the currently focused waypoint input
  const activeQuery = focusedField !== null ? (inputValues[focusedField] ?? "") : "";
  const debouncedActiveQuery = useDebounce(activeQuery, 300);
  // Rank suggestions near the visible map. A cheap ref read each render; the
  // hook rounds the point, so small pans keep the same query key.
  const suggestionMap = mapContext?.mapRef.current;
  const suggestionCenter = suggestionMap?.getCenter();
  const suggestionBias =
    suggestionMap && suggestionCenter
      ? {
          proximity: [suggestionCenter.lng, suggestionCenter.lat] as LngLat,
          zoom: suggestionMap.getZoom(),
        }
      : null;
  const { data: wsSuggestions } = useAutocomplete(debouncedActiveQuery, locale, suggestionBias);
  const showSuggestions = focusedField !== null && (wsSuggestions?.length ?? 0) > 0;
  const waypointAttributions = showSuggestions
    ? servedAttributions(registry, wsSuggestions ?? [])
    : [];

  const displayedGroundResult = scheduleRequest ? scheduledData : data;
  const detailsRoute =
    detailsRouteIndex !== null ? (displayedGroundResult?.routes[detailsRouteIndex] ?? null) : null;
  const routingAttributions = useMemo<Attribution[]>(() => {
    const routes = displayedGroundResult?.routes ?? [];
    const displayed = !scheduleRequest && waypoints.length > 2 ? routes.slice(0, 1) : routes;
    return snapshotContributors(
      ...displayed.map((route) =>
        snapshotContributors(
          routeAttributions(registry, displayedGroundResult?.provider, route, [
            "distance",
            "duration",
            "mode",
            ...(route.summary ? ["summary"] : []),
            ...(route.usesLocalAccessRoad ? ["usesLocalAccessRoad"] : []),
            ...((route.mode === "walking" || route.mode === "cycling") && route.elevation?.length
              ? ["geometry", "elevation"]
              : []),
          ]),
          ...(!scheduleRequest && waypoints.length > 2 && route.legs.length > 1
            ? route.legs.map((leg, index) =>
                contributorsForNestedRecordFields(
                  route,
                  [{ field: `legs.${index}`, record: leg }],
                  ["duration", "distance"],
                ),
              )
            : []),
        ),
      ),
    );
  }, [registry, displayedGroundResult, scheduleRequest, waypoints.length]);

  const getCachedDuration = (m: TravelMode) => {
    if (!allWaypointsFilled) return undefined;
    // Build the key with the shared builder so it always matches what
    // useDirections stored — driving carries the time pickers, other modes don't.
    const cached = queryClient.getQueryData<DirectionsResult>(
      directionsQueryKey({
        waypoints: routeWaypoints,
        mode: m,
        avoidHighways,
        avoidTolls,
        avoidFerries,
        bikeProfile,
        bikeHillPreference,
        bikePreferQuietRoads,
        bikePreferSmoothSurfaces,
        bikeSpeedKmh,
        avoidClosures: avoidIncidents,
        units,
        lang: locale,
        departAt: m === "driving" ? drivingDepartAtStr : undefined,
        arriveBy: m === "driving" ? drivingArriveByStr : undefined,
      }),
    );
    const route = cached?.routes[0];
    return route?.duration !== undefined
      ? {
          time: formatDuration(route.duration),
          contributors: contributorsForField(route, "duration"),
        }
      : undefined;
  };
  // Derive the visible text and its captured ownership together, once per button.
  const modeButtons = MODES.map((button) => {
    const isActive = mode === button.mode;
    const isTransit = button.mode === "transit";
    const cached = isTransit || button.disabled ? undefined : getCachedDuration(button.mode);
    const record = isTransit
      ? isActive
        ? transitItineraries[0]
        : undefined
      : isActive
        ? data?.routes[0]
        : undefined;
    const duration = button.disabled
      ? undefined
      : record?.duration !== undefined
        ? {
            time: formatDuration(record.duration),
            contributors: contributorsForField(record, "duration"),
          }
        : cached;
    const loading = isActive && (isTransit ? transitLoading : isLoading && !cached);
    return {
      ...button,
      isActive,
      loading,
      time: duration?.time,
      contributors: !loading && duration ? duration.contributors : [],
    };
  });
  const modeDurationAttributions = snapshotContributors(
    ...modeButtons.map((button) => button.contributors),
  );

  const handleUseMyLocation = useCallback(() => {
    if (userLocation) {
      setWaypoint(0, userLocation, t("myLocation"));
    }
  }, [userLocation, setWaypoint, t]);

  const handleWaypointBlur = useCallback(() => {
    setTimeout(() => setFocusedField(null), 150);
  }, []);

  // Expand to full so the autocomplete dropdown that opens under the focused
  // field has room — mid only shows a couple of rows.
  const handleWaypointFocus = useCallback(
    (index: number) => {
      setFocusedField(index);
      snapTo("full");
    },
    [snapTo],
  );

  const handleInputChange = useCallback(
    (index: number, value: string) => {
      setInputValues((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
      if (!value) {
        setWaypoint(index, null, "");
      }
    },
    [setWaypoint],
  );

  const handleSuggestionSelect = (result: AutocompleteResult) => {
    if (!result.coordinates || focusedField === null) return;
    const { label, coordinates } = result;
    setInputValues((prev) => {
      const next = [...prev];
      next[focusedField] = label;
      return next;
    });
    setWaypoint(focusedField, coordinates, label);
    setFocusedField(null);
  };

  const handleReverse = useCallback(() => {
    reverseWaypoints();
    setInputValues((prev) => [...prev].reverse());
  }, [reverseWaypoints]);

  const handleRemove = useCallback(
    (index: number) => {
      removeWaypoint(index);
      setInputValues((prev) => {
        const next = [...prev];
        next.splice(index, 1);
        return next;
      });
    },
    [removeWaypoint],
  );

  const handleAdd = useCallback(
    (afterIndex: number) => {
      addWaypoint(afterIndex);
      setInputValues((prev) => {
        const next = [...prev];
        next.splice(afterIndex + 1, 0, "");
        return next;
      });
    },
    [addWaypoint],
  );

  const focusWaypoint = (index: number) => {
    waypointListRef.current?.querySelectorAll("input")[index]?.focus();
  };
  const valhallaAvailable = caps["routing-valhalla"]?.available === true;
  const osrmAvailable =
    caps["routing-osrm"]?.available === true &&
    !avoidIncidents &&
    !waypoints.some((wp) => wp.schedule !== undefined) &&
    !(timeMode !== "now" && tripTime);
  const fallbackModes = GROUND_FALLBACK_MODES.filter(
    (candidate) =>
      candidate !== mode &&
      (candidate === "driving" ? valhallaAvailable || osrmAvailable : valhallaAvailable),
  );
  const selectFallbackMode = (nextMode: GroundFallbackMode) => {
    setMode(nextMode);
    setDetailsRouteIndex(null);
    setTransitDetailsIndex(null);
  };
  const recoveryActions = {
    onEditOrigin: () => focusWaypoint(0),
    onEditDestination: () => focusWaypoint(waypoints.length - 1),
    modes: fallbackModes,
    onSelectMode: selectFallbackMode,
  };

  const handleOptimize = useCallback(() => {
    if (routeWaypoints.length < 3) return;
    optimizeMutation.mutate(
      {
        waypoints: routeWaypoints,
        mode,
        avoidHighways,
        avoidTolls,
        avoidFerries,
        bikeProfile,
        bikeHillPreference,
        bikePreferQuietRoads,
        bikePreferSmoothSurfaces,
        bikeSpeedKmh,
        units,
      },
      {
        onSuccess: (result) => {
          if (!result.optimizedOrder) return;
          // Moves each waypoint whole, so a stop's dwell travels with it.
          setSnackbar(
            applyWaypointOrder(result.optimizedOrder)
              ? t("routeOptimized")
              : t("scheduleOptimizeBlocked"),
          );
        },
        onError: () => {
          setSnackbar(t("noRoutesFound"));
        },
      },
    );
  }, [
    routeWaypoints,
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    bikeProfile,
    bikeHillPreference,
    bikePreferQuietRoads,
    bikePreferSmoothSurfaces,
    bikeSpeedKmh,
    units,
    optimizeMutation,
    applyWaypointOrder,
    t,
  ]);

  const hasMultipleStops = waypoints.length > 2;
  const showOptimize =
    hasMultipleStops && allWaypointsFilled && !isTransitMode && !hidesRouteControls;
  // Reordering could move a stop past its appointment, and the optimize engine
  // has no notion of time windows, so it is refused rather than silently wrong.
  const optimizeBlocked = waypoints.some(
    (wp) =>
      wp.schedule?.departAfter !== undefined ||
      wp.schedule?.arriveBy !== undefined ||
      wp.schedule?.fixedAt !== undefined,
  );
  const lowestCo2Grams = useMemo(() => {
    const values = transitItineraries
      .map((itinerary) => itinerary.co2Grams)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length < 2) return null;
    return Math.min(...values);
  }, [transitItineraries]);

  if (transitDetailsIndex !== null && transitItineraries[transitDetailsIndex]) {
    return (
      <AttributionDetailsGroup placement="footer" label={tc("dataSources")}>
        <TransitDetailsView
          itinerary={transitItineraries[transitDetailsIndex]}
          isLowestCo2={
            lowestCo2Grams !== null &&
            transitItineraries[transitDetailsIndex]?.co2Grams === lowestCo2Grams
          }
          originLabel={originLabel}
          destinationLabel={destinationLabel}
          provider={transitPlanData?.provider}
          attributions={snapshotContributors(
            transitItineraries[transitDetailsIndex]?.contributors ?? [],
          )}
          originTimeZone={originTimeZone}
          destinationTimeZone={destinationTimeZone}
          onBack={() => setTransitDetailsIndex(null)}
        />
      </AttributionDetailsGroup>
    );
  }

  if (detailsRoute) {
    return (
      <DetailsView
        route={detailsRoute}
        attributions={routeAttributions(registry, displayedGroundResult?.provider, detailsRoute)}
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        waypointLabels={waypoints.map((wp) => wp.label)}
        units={units}
        onBack={() => setDetailsRouteIndex(null)}
      />
    );
  }

  // The depart/arrive picker is shared by transit and driving (driving uses
  // local state; transit uses the store). `activeTime*` adapt the shared
  // controlled picker to whichever flow is active.
  const showTimePicker = isTransitMode || isDrivingTimeMode;
  const activeTimeMode: TimeMode = isTransitMode ? transitTimeMode : timeMode;
  const activeTimeValue: Date | null = isTransitMode
    ? activeTimeMode === "depart"
      ? transitDepartureTime instanceof Date
        ? transitDepartureTime
        : null
      : activeTimeMode === "arrive"
        ? transitArrivalTime instanceof Date
          ? transitArrivalTime
          : null
        : null
    : tripTime;
  const handleTimeModeChange = (m: TimeMode) => {
    if (isTransitMode) {
      setTransitTimeMode(m);
      if (m === "now") {
        setTransitDepartureTime("now");
        setTransitArrivalTime(null);
      } else if (m === "depart" && !(transitDepartureTime instanceof Date)) {
        setTransitDepartureTime(new Date());
      } else if (m === "arrive" && !transitArrivalTime) {
        setTransitArrivalTime(new Date());
      }
    } else {
      setTimeMode(m);
      if (m !== "now" && !tripTime) setTripTime(new Date());
    }
  };
  const handleTimeValueChange = (d: Date) => {
    if (isTransitMode) {
      if (transitTimeMode === "depart") setTransitDepartureTime(d);
      else setTransitArrivalTime(d);
    } else {
      setTripTime(d);
    }
  };

  return (
    // Tapping the collapsed sheet's background opens it to mid.
    <Box onClick={expandOnBackgroundTap}>
      {/* Keep panel actions separate so every travel mode gets the full panel width. */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          px: 1,
          pt: 0.5,
        }}
      >
        <IconButton
          size="small"
          aria-label={t("menu")}
          onClick={() => useMenuStore.getState().open()}
          sx={{ width: 44, height: 44, flexShrink: 0 }}
        >
          <MenuIcon sx={{ fontSize: 22 }} />
        </IconButton>
        <Typography variant="subtitle2" sx={{ ml: 1, flex: 1, fontWeight: 600 }}>
          {t("routes")}
        </Typography>
        <IconButton
          size="small"
          onClick={() => useSidebarStore.getState().closeSidebar()}
          sx={{ width: 44, height: 44, flexShrink: 0 }}
          aria-label={t("close")}
        >
          <CloseIcon sx={{ fontSize: 22 }} />
        </IconButton>
      </Box>

      <Box
        role="radiogroup"
        aria-label={t("travelMode")}
        sx={{
          display: "flex",
          width: "100%",
          boxSizing: "border-box",
          px: "6px",
          pb: 0.25,
          justifyContent: "space-around",
          flexWrap: "wrap",
        }}
      >
        {modeButtons.map(({ mode: m, icon, labelKey, disabled, isActive, time, loading }) => {
          return (
            <ModeButton
              key={m}
              mode={m}
              name="travel-mode"
              icon={icon}
              label={t(labelKey)}
              time={time}
              active={isActive}
              disabled={disabled}
              loading={loading}
              onClick={() => {
                setMode(m);
                setDetailsRouteIndex(null);
                setTransitDetailsIndex(null);
              }}
            />
          );
        })}
      </Box>
      {/* Driving sub-mode: normal route vs. EV charge planning. EV is a subtype
          of driving, not its own top-level mode, so it lives here rather than in
          the mode row. */}
      {mode === "driving" && (
        // Left-aligned with the waypoint inputs rather than the panel edge:
        // WaypointList's px (12px) + WaypointRow's 24px icon column + its 4px gap.
        <Box sx={{ pl: 5, pr: 1.5, pt: 1 }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={isEvMode ? "ev" : "route"}
            onChange={(_, value) => {
              if (!value) return;
              setEvMode(value === "ev");
              setDetailsRouteIndex(null);
              setTransitDetailsIndex(null);
            }}
            aria-label={t("driving")}
            sx={{ "& .MuiToggleButton-root": { textTransform: "none", py: 0.3, px: 1.2 } }}
          >
            <ToggleButton value="route">
              <DirectionsCarIcon sx={{ fontSize: 18, mr: 0.5 }} />
              {t("driving")}
            </ToggleButton>
            <ToggleButton value="ev">
              <EvStationIcon sx={{ fontSize: 18, mr: 0.5 }} />
              {t("evMode")}
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      )}
      {/* Waypoint list with drag-and-drop */}
      <Box ref={waypointListRef}>
        <WaypointList
          waypoints={waypoints}
          inputValues={inputValues}
          onInputChange={handleInputChange}
          onFocus={handleWaypointFocus}
          onBlur={handleWaypointBlur}
          onReorder={reorderWaypoints}
          onAdd={handleAdd}
          onRemove={handleRemove}
          onReverse={handleReverse}
          onUseMyLocation={userLocation ? handleUseMyLocation : undefined}
          onEditSchedule={isEvMode || isFlightMode ? undefined : setScheduleEditIndex}
          isEvMode={isEvMode}
          t={t}
        />
      </Box>
      {/* Divider + content below */}
      <Box sx={{ position: "relative" }}>
        <Divider />

        {/* Optimize button */}
        {showOptimize && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 2,
              py: 0.75,
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <Typography
              component="button"
              type="button"
              variant="body2"
              onClick={handleOptimize}
              disabled={optimizeBlocked}
              title={optimizeBlocked ? t("scheduleOptimizeBlocked") : undefined}
              sx={{
                color: optimizeBlocked ? "text.disabled" : BRAND,
                cursor: optimizeBlocked ? "not-allowed" : "pointer",
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 0.75,
                px: 1.5,
                py: 0.5,
                border: "none",
                background: "none",
                font: "inherit",
                borderRadius: 99,
                "&:hover": { bgcolor: optimizeBlocked ? "transparent" : `${BRAND}18` },
                transition: "background-color 0.15s",
              }}
            >
              {optimizeMutation.isPending ? (
                <>
                  <CircularProgress size={14} sx={{ color: BRAND }} />
                  {t("optimizing")}
                </>
              ) : (
                <>
                  <RouteIcon sx={{ fontSize: 16 }} />
                  {t("optimizeStopOrder")}
                </>
              )}
            </Typography>
          </Box>
        )}

        {/* Leave now / Depart at / Arrive by (transit only) + Options (non-transit).
            Flight mode renders its own form below, so this row is hidden. */}
        {!hidesRouteControls && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: showTimePicker ? "space-between" : "flex-end",
              px: 2,
              py: 1,
            }}
          >
            {showTimePicker && (
              <Box
                onClick={() => setTimePickerOpen((v) => !v)}
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 0.75,
                  px: 1.75,
                  py: 0.75,
                  borderRadius: "12px",
                  bgcolor: activeTimeMode !== "now" ? `${BRAND}18` : "action.hover",
                  cursor: "pointer",
                  "&:hover": {
                    bgcolor: activeTimeMode !== "now" ? `${BRAND}28` : "action.selected",
                  },
                  transition: "background-color 0.15s",
                }}
              >
                <ScheduleIcon
                  sx={{ fontSize: 18, color: activeTimeMode !== "now" ? BRAND : "text.primary" }}
                />
                <Typography
                  variant="body2"
                  color={activeTimeMode !== "now" ? BRAND : "text.primary"}
                  sx={{
                    fontWeight: 500,
                  }}
                >
                  {activeTimeMode === "now"
                    ? t("departNow")
                    : activeTimeMode === "depart"
                      ? `${t("departAt")} ${activeTimeValue ? fmt.time(activeTimeValue) : ""}`
                      : `${t("arriveBy")} ${activeTimeValue ? fmt.time(activeTimeValue) : ""}`}
                </Typography>
                <ExpandMoreIcon
                  sx={{ fontSize: 18, color: activeTimeMode !== "now" ? BRAND : "text.primary" }}
                />
              </Box>
            )}

            <Typography
              variant="body2"
              sx={{
                color: showOptions ? BRAND : "text.secondary",
                cursor: "pointer",
                fontWeight: 500,
                px: 1.5,
                py: 0.75,
                borderRadius: 99,
                "&:hover": { bgcolor: `${BRAND}18`, color: BRAND },
                transition: "background-color 0.15s, color 0.15s",
              }}
              onClick={() => setShowOptions((v) => !v)}
            >
              {t("options")}
            </Typography>
          </Box>
        )}

        {/* Depart-at / arrive-by picker (shared by transit + driving) */}
        {showTimePicker && timePickerOpen && (
          <TimeModePicker
            timeMode={activeTimeMode}
            value={activeTimeValue}
            onTimeModeChange={handleTimeModeChange}
            onValueChange={handleTimeValueChange}
          />
        )}

        {showOptions && !hidesRouteControls && <RouteOptions />}

        {/* Share row — sits between the options row and the offered routes */}
        {!hidesRouteControls && allWaypointsFilled && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              px: 2,
              py: 0.75,
              borderTop: "1px solid",
              borderColor: "divider",
              bgcolor: "action.hover",
            }}
          >
            <Box
              component="button"
              type="button"
              onClick={handleShare}
              sx={{
                display: "inline-flex",
                alignItems: "center",
                gap: 0.75,
                border: 0,
                bgcolor: "transparent",
                color: BRAND,
                cursor: "pointer",
                fontWeight: 500,
                fontFamily: "inherit",
                fontSize: "0.875rem",
                px: 1,
                py: 0.5,
                borderRadius: 99,
                "&:hover": { bgcolor: `${BRAND}18` },
                transition: "background-color 0.15s",
              }}
            >
              <ShareIcon sx={{ fontSize: 18 }} />
              {tp("share")}
            </Box>
          </Box>
        )}

        <Divider />

        {/* Plain-route energy/cost + vehicle chip, driving mode only (EV mode
            gets its own vehicle inputs via EvVehiclePanel above). */}

        {/* Route results */}
        <AttributionDetailsGroup placement="footer" label={tc("dataSources")}>
          <AttributionStrip attributions={modeDurationAttributions} provenanceDisplay="details" />
          {isFlightMode ? (
            <FlightPanel />
          ) : isRideMode ? (
            <>
              {allWaypointsFilled &&
                (isLoading || (isError && directionsQuery.isFetching) || (!data && !isError) ? (
                  <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                    <CircularProgress size={28} sx={{ color: BRAND }} />
                  </Box>
                ) : isError ? (
                  <RouteRecovery
                    failed
                    error={directionsQuery.error}
                    onRetry={() => void directionsQuery.refetch()}
                    {...recoveryActions}
                  />
                ) : data?.routes.length === 0 ? (
                  <RouteRecovery failed={false} {...recoveryActions} />
                ) : null)}
              <RidePanel
                route={
                  !isError && data?.routes[0]
                    ? {
                        distanceMeters: data.routes[0].distance,
                        durationSeconds: data.routes[0].duration,
                      }
                    : undefined
                }
              />
            </>
          ) : !allWaypointsFilled ? (
            <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                {t("chooseOrigin")}
              </Typography>
            </Box>
          ) : isEvMode ? (
            <>
              <EvVehiclePanel />
              {!evRequest ? null : evLoading ||
                (evIsError && evQuery.isFetching) ||
                (!evData && !evIsError) ? (
                <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                  <CircularProgress size={28} sx={{ color: BRAND }} />
                </Box>
              ) : evIsError ? (
                <RouteRecovery
                  failed
                  error={evQuery.error}
                  onRetry={() => void evQuery.refetch()}
                  {...recoveryActions}
                />
              ) : evData?.routes.length === 0 ? (
                <RouteRecovery failed={false} {...recoveryActions} />
              ) : evData ? (
                <EvPlanCard
                  result={evData}
                  onRetryWithoutNetworkRestriction={() => setEvForceNonExclusive(true)}
                />
              ) : null}
            </>
          ) : transitIsChained ? (
            transitChainQuery.isLoading ||
            (transitChainQuery.isError && transitChainQuery.isFetching) ||
            (!transitChainData && !transitChainQuery.isError) ? (
              <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                <CircularProgress size={28} sx={{ color: BRAND }} />
              </Box>
            ) : transitChainQuery.isError ? (
              <RouteRecovery
                failed
                error={transitChainQuery.error}
                onRetry={() => void transitChainQuery.refetch()}
                {...recoveryActions}
              />
            ) : transitChainData ? (
              <>
                {transitChainData.segments.length === 0 && (
                  <RouteRecovery failed={false} {...recoveryActions} />
                )}
                <TransitChainView
                  plan={transitChainData}
                  waypointLabels={waypoints.map((wp) => wp.label)}
                />
              </>
            ) : null
          ) : isTransitMode ? (
            transitLoading ||
            (transitError && transitPlanQuery.isFetching) ||
            (!transitPlanData && !transitError) ? (
              <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                <CircularProgress size={28} sx={{ color: BRAND }} />
              </Box>
            ) : transitError ? (
              <RouteRecovery
                failed
                error={transitPlanQuery.error}
                onRetry={() => void transitPlanQuery.refetch()}
                {...recoveryActions}
              />
            ) : transitPlanData?.itineraries.length === 0 && !transitPaging.isPage ? (
              <RouteRecovery failed={false} {...recoveryActions} />
            ) : transitItineraries.length === 0 ? (
              <RouteRecovery failed={false} {...recoveryActions} />
            ) : (
              <>
                {transitItineraries.map((itin, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: itineraries have no stable id
                  <Box key={i}>
                    <TransitItineraryCard
                      itinerary={itin}
                      active={i === activeItineraryIndex}
                      isLowestCo2={lowestCo2Grams !== null && itin.co2Grams === lowestCo2Grams}
                      replanOptions={transitReplanOptions}
                      originTimeZone={originTimeZone}
                      destinationTimeZone={destinationTimeZone}
                      onSelect={() => {
                        setActiveItineraryIndex(i);
                        snapTo("peek");
                      }}
                      onDetails={() => setTransitDetailsIndex(i)}
                      onRefreshed={(updated, changed, fallbackOccurred) => {
                        const current = useDirectionsStore.getState().transitItineraries;
                        setTransitItineraries(
                          current.map((candidate, index) => (index === i ? updated : candidate)),
                        );
                        if (changed || fallbackOccurred) {
                          setSnackbar(
                            fallbackOccurred ? t("connectionReplanned") : t("connectionUpdated"),
                          );
                        }
                      }}
                    />
                    {i < transitItineraries.length - 1 && <Divider />}
                  </Box>
                ))}
                {destinationOffsetLabel && (
                  <Typography sx={{ fontSize: 11, color: "text.secondary", px: 2, pb: 1 }}>
                    {t("arrivalInDestinationTime")}
                  </Typography>
                )}
                {(transitPaging.previousToken || transitPaging.nextToken) && (
                  <Box sx={{ px: 2, py: 1, borderTop: "1px solid", borderColor: "divider" }}>
                    <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
                      <Button
                        size="small"
                        disabled={!transitPaging.previousToken || transitLoading}
                        onClick={transitPaging.loadPrevious}
                      >
                        {t("earlierConnections")}
                      </Button>
                      <Button
                        size="small"
                        disabled={!transitPaging.nextToken || transitLoading}
                        onClick={transitPaging.loadNext}
                      >
                        {t("laterConnections")}
                      </Button>
                    </Box>
                  </Box>
                )}
                <AttributionStrip
                  attributions={transitPlanAttributions}
                  variant="panel-header"
                  label={tc("dataSources")}
                />
              </>
            )
          ) : scheduleRequest &&
            (scheduledQuery.isLoading || (scheduledQuery.isError && scheduledQuery.isFetching)) ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={28} sx={{ color: BRAND }} />
            </Box>
          ) : scheduleRequest && scheduledQuery.isError ? (
            <RouteRecovery
              failed
              error={scheduledQuery.error}
              onRetry={() => void scheduledQuery.refetch()}
              {...recoveryActions}
            />
          ) : scheduleRequest && scheduledData?.routes.length === 0 ? (
            <RouteRecovery failed={false} {...recoveryActions} />
          ) : scheduleRequest && !scheduledData ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={28} sx={{ color: BRAND }} />
            </Box>
          ) : !scheduleRequest &&
            (isLoading || (isError && directionsQuery.isFetching) || (!data && !isError)) ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={28} sx={{ color: BRAND }} />
            </Box>
          ) : !scheduleRequest && isError ? (
            <RouteRecovery
              failed
              error={directionsQuery.error}
              onRetry={() => void directionsQuery.refetch()}
              {...recoveryActions}
            />
          ) : !scheduleRequest && hasMultipleStops && data?.routes[0] ? (
            // Multi-stop: single route with leg summary
            <>
              <Box>
                <Box
                  sx={{
                    px: 2,
                    py: 1.5,
                    cursor: "pointer",
                    borderLeft: `4px solid ${BRAND}`,
                    bgcolor: "rgba(0,123,139,0.04)",
                    "&:hover": { bgcolor: "rgba(0,123,139,0.07)" },
                  }}
                  onClick={() => setDetailsRouteIndex(0)}
                >
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                    }}
                  >
                    <Typography
                      variant="body2"
                      sx={{
                        fontWeight: 600,
                        color: "text.primary",
                      }}
                    >
                      {formatDuration(data.routes[0].duration)}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {units === "imperial"
                        ? `${(data.routes[0].distance / 1609.34).toFixed(1)} mi`
                        : formatDistance(data.routes[0].distance)}
                    </Typography>
                  </Box>
                  {data.routes[0].legs.length > 1 && (
                    <Box sx={{ mt: 1 }}>
                      {data.routes[0].legs.map((leg, i) => {
                        const fromLabel = waypoints[i]?.label || t("origin");
                        const toLabel = waypoints[i + 1]?.label || t("destination");
                        return (
                          <Typography
                            // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
                            key={i}
                            variant="caption"
                            sx={{
                              color: "text.secondary",
                              display: "block",
                              lineHeight: 1.6,
                            }}
                          >
                            {fromLabel}→ {toLabel}
                            {" · "}
                            {formatDuration(leg.duration)}
                            {" · "}
                            {units === "imperial"
                              ? `${(leg.distance / 1609.34).toFixed(1)} mi`
                              : formatDistance(leg.distance)}
                          </Typography>
                        );
                      })}
                    </Box>
                  )}
                  <Box sx={{ mt: 0.5, ml: -1.5 }}>
                    <Typography
                      component="span"
                      variant="caption"
                      sx={{
                        color: BRAND,
                        cursor: "pointer",
                        fontWeight: 500,
                        px: 1.5,
                        py: 0.75,
                        borderRadius: 99,
                        "&:hover": { bgcolor: `${BRAND}18` },
                        transition: "background-color 0.15s",
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetailsRouteIndex(0);
                      }}
                    >
                      {tc("details")}
                    </Typography>
                  </Box>
                </Box>
              </Box>
              <AttributionStrip
                attributions={routingAttributions}
                variant="panel-header"
                label={tc("dataSources")}
              />
            </>
          ) : scheduledData ? (
            <>
              {scheduledData.routes.map((route, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: routes have no stable id
                <Box key={i}>
                  <RouteCard
                    route={route}
                    index={i}
                    active
                    selectionKind="peek"
                    isFastest={i === fastestRouteIndex}
                    onSelect={() => snapTo("peek")}
                    onDetails={() => setDetailsRouteIndex(i)}
                    units={units}
                    arrivalContext={{
                      kind: "scheduled",
                      arrival: scheduledData.schedule.arrival,
                      destinationTimeZone: destination
                        ? timeZoneAt(destination[1], destination[0])
                        : null,
                    }}
                    provider={scheduledData.provider}
                    roadConditionImpact={scheduledData.roadConditionImpact}
                    impact={routeImpacts[i]}
                    impactUnavailableReason={routeImpactUnavailableReason}
                    vehicles={impactVehicles}
                    onUpdateAssumptions={handleUpdateAssumptions}
                  />
                </Box>
              ))}
              <Divider />
              <TripScheduleCard
                schedule={scheduledData.schedule}
                fidelity={scheduledData.fidelity}
                warnings={scheduledData.warnings}
                waypointLabels={waypoints.map((wp) => wp.label)}
              />
              <AttributionStrip
                attributions={routingAttributions}
                variant="panel-header"
                label={tc("dataSources")}
              />
            </>
          ) : !scheduleRequest && data?.routes.length ? (
            <>
              <Box role="radiogroup" aria-label={t("routes")}>
                {data.routes.map((route, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: routes have no stable id
                  <Box key={i}>
                    <RouteCard
                      route={route}
                      index={i}
                      active={i === activeRouteIndex}
                      isFastest={i === fastestRouteIndex}
                      onSelect={() => {
                        setActiveRouteIndex(i);
                        snapTo("peek");
                      }}
                      onDetails={() => setDetailsRouteIndex(i)}
                      units={units}
                      arrivalContext={arrivalContext}
                      alternatives={data.routes.filter((_, idx) => idx !== i)}
                      provider={data.provider}
                      roadConditionImpact={data.roadConditionImpact}
                      impact={routeImpacts[i]}
                      impactUnavailableReason={routeImpactUnavailableReason}
                      vehicles={impactVehicles}
                      onUpdateAssumptions={handleUpdateAssumptions}
                    />
                    {i < data.routes.length - 1 && <Divider />}
                  </Box>
                ))}
              </Box>
              <AttributionStrip
                attributions={routingAttributions}
                variant="panel-header"
                label={tc("dataSources")}
              />
            </>
          ) : !scheduleRequest && data ? (
            <RouteRecovery failed={false} {...recoveryActions} />
          ) : null}
        </AttributionDetailsGroup>

        {/* Suggestions overlay */}
        {showSuggestions && (
          <Box
            sx={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bgcolor: "background.paper",
              zIndex: 2,
              boxShadow: "0 4px 12px var(--omx-shadow-soft)",
            }}
          >
            <AutocompleteDropdown
              suggestions={wsSuggestions ?? []}
              onSelect={handleSuggestionSelect}
            />
            {waypointAttributions.length > 0 && (
              <Box sx={{ px: 2, py: 0.75 }}>
                <AttributionStrip attributions={waypointAttributions} variant="plain" />
              </Box>
            )}
          </Box>
        )}
      </Box>
      <Snackbar
        open={snackbar !== null}
        autoHideDuration={3000}
        onClose={() => setSnackbar(null)}
        message={snackbar}
      />
      <Menu
        anchorEl={shareMenuAnchor}
        open={Boolean(shareMenuAnchor)}
        onClose={() => setShareMenuAnchor(null)}
      >
        <MenuItem onClick={() => void handleCopyCurrentView()}>
          {tShare("copyCurrentView")}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setShareMenuAnchor(null);
            setShareRouteDialogOpen(true);
          }}
        >
          {tShare("createShareLink")}
        </MenuItem>
      </Menu>
      <ShareRouteDialog
        open={shareRouteDialogOpen}
        onClose={() => setShareRouteDialogOpen(false)}
      />
      {scheduleEditIndex !== null && waypoints[scheduleEditIndex]?.coords && (
        <WaypointScheduleDialog
          open
          waypointLabel={waypoints[scheduleEditIndex].label}
          coords={waypoints[scheduleEditIndex].coords}
          schedule={waypoints[scheduleEditIndex].schedule}
          onSave={(schedule) => setWaypointSchedule(scheduleEditIndex, schedule)}
          onClose={() => setScheduleEditIndex(null)}
        />
      )}
    </Box>
  );
}
