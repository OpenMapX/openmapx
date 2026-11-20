"use client";

import CloseIcon from "@mui/icons-material/Close";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import EvStationIcon from "@mui/icons-material/EvStation";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MenuIcon from "@mui/icons-material/Menu";
import RouteIcon from "@mui/icons-material/Route";
import ScheduleIcon from "@mui/icons-material/Schedule";
import ShareIcon from "@mui/icons-material/Share";
import TuneIcon from "@mui/icons-material/Tune";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Snackbar from "@mui/material/Snackbar";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { AutocompleteResult, LngLat, TravelMode, Waypoint } from "@openmapx/core";
import {
  CALLER_SHOWS_ERRORS,
  formatDuration,
  timeZoneAt,
  tzDiffMinutes,
  tzOffsetLabel,
  useAutocomplete,
  useCapabilities,
  useDebounce,
  useDirectionsStore,
  useMapStore,
  useMenuStore,
  useOptimizeRoute,
  useSession,
  useSettingsStore,
  useSidebarStore,
  viewerTimeZone,
} from "@openmapx/core";
import { transitItineraryFingerprint } from "@openmapx/core/navigation";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { contributorsForField, snapshotContributors } from "@openmapx/mobility-core/contributors";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { DetailsView } from "@/components/panels/directions/DetailsView";
import { EvPlanCard } from "@/components/panels/directions/EvPlanCard";
import { EvVehiclePanel } from "@/components/panels/directions/EvVehiclePanel";
import { FlightPanel } from "@/components/panels/directions/FlightPanel";
import { MODES, ModeButton } from "@/components/panels/directions/ModeSelector";
import { PhoneWaypointCard } from "@/components/panels/directions/PhoneWaypointCard";
import { RidePanel } from "@/components/panels/directions/RidePanel";
import { RouteCard } from "@/components/panels/directions/RouteCard";
import { RouteOptions } from "@/components/panels/directions/RouteOptions";
import { RouteStopSearch } from "@/components/panels/directions/RouteStopSearch";
import { ShareRouteDialog } from "@/components/panels/directions/ShareRouteDialog";
import { type TimeMode, TimeModePicker } from "@/components/panels/directions/TimeModePicker";
import { TransitChainView } from "@/components/panels/directions/TransitChainView";
import { TransitDetailsView } from "@/components/panels/directions/TransitDetailsView";
import { TransitItineraryCard } from "@/components/panels/directions/TransitRouteView";
import { TripScheduleCard } from "@/components/panels/directions/TripScheduleCard";
import { useWaypointDrafts } from "@/components/panels/directions/useWaypointDrafts";
import { WaypointList, waypointPlaceholder } from "@/components/panels/directions/WaypointList";
import { WaypointScheduleDialog } from "@/components/panels/directions/WaypointScheduleDialog";
import { useExpandOnBackgroundTap, useMobileSheet } from "@/components/panels/sheet/sheetState";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { AttributionDetailsGroup } from "@/components/ui/AttributionDetailsGroup";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { ClickableRow } from "@/components/ui/ClickableRow";
import Menu from "@/components/ui/Menu";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { shareCurrentUrl } from "@/lib/deepLink";
import { useForegroundLocation } from "@/lib/mobile/useForegroundLocation";
import { routeAttributions } from "@/lib/routeAttributions";
import { servedAttributions } from "@/lib/servedAttributions";
import { useStopSearchStore } from "@/stores/stopSearchStore";
import { isTimedGroundMode } from "./directionsRequests";
import { MultiStopRouteSummary } from "./MultiStopRouteSummary";
import {
  GROUND_FALLBACK_MODES,
  type GroundFallbackMode,
  NoRoutesFound,
  planState,
  type RouteRecoveryActions,
  RouteResultStates,
} from "./RouteResultStates";
import { findTransitItinerary } from "./transitPlanPages";
import { useDirectionsDetailsNavigation } from "./useDirectionsDetailsNavigation";
import { useGroundDirectionsPlan } from "./useGroundDirectionsPlan";
import { useTransitDirectionsPlan } from "./useTransitDirectionsPlan";

/** Whether two itineraries hold the same stops, at the same places, in the same order. */
function sameStops(a: readonly Waypoint[], b: readonly Waypoint[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (wp, i) =>
        wp.id === b[i]?.id &&
        wp.coords?.[0] === b[i]?.coords?.[0] &&
        wp.coords?.[1] === b[i]?.coords?.[1],
    )
  );
}

export function DirectionsPanelContent() {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const tp = useTranslations("place");
  const tShare = useTranslations("share");
  const locale = useLocale();
  const fmt = useDateTimeFormat();
  const { snapTo, inSheet } = useMobileSheet();
  const expandOnBackgroundTap = useExpandOnBackgroundTap();
  const { isOpen, waypoints, mode, isEvMode, activeRouteIndex, activeItineraryIndex } =
    useDirectionsStore(
      useShallow((s) => ({
        isOpen: s.isOpen,
        waypoints: s.waypoints,
        mode: s.mode,
        isEvMode: s.isEvMode,
        activeRouteIndex: s.activeRouteIndex,
        activeItineraryIndex: s.activeItineraryIndex,
      })),
    );
  const transitOptions = useDirectionsStore(
    useShallow((s) => ({
      timeMode: s.transitTimeMode,
      transitDepartureTime: s.transitDepartureTime,
      transitArrivalTime: s.transitArrivalTime,
      transitPreferredModes: s.transitPreferredModes,
      transitRoutePreference: s.transitRoutePreference,
      transitAccessMode: s.transitAccessMode,
      wheelchairRequired: s.wheelchairRequired,
      maxTransfers: s.maxTransfers,
      transferBuffer: s.transferBuffer,
      requireBikeTransport: s.requireBikeTransport,
      bikeHillPreference: s.bikeHillPreference,
      deutschlandticketOnly: s.deutschlandticketOnly,
    })),
  );
  const routeOptions = useDirectionsStore(
    useShallow((s) => ({
      avoidHighways: s.avoidHighways,
      avoidTolls: s.avoidTolls,
      avoidFerries: s.avoidFerries,
      bikeProfile: s.bikeProfile,
      bikeHillPreference: s.bikeHillPreference,
      bikePreferQuietRoads: s.bikePreferQuietRoads,
      bikePreferSmoothSurfaces: s.bikePreferSmoothSurfaces,
      bikeSpeedKmh: s.bikeSpeedKmh,
    })),
  );
  const { timeMode, tripTime } = useDirectionsStore(
    useShallow((s) => ({ timeMode: s.timeMode, tripTime: s.tripTime })),
  );
  const {
    setTransitTimeMode,
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
  } = useDirectionsStore(
    useShallow((s) => ({
      setTransitTimeMode: s.setTransitTimeMode,
      setTimeMode: s.setTimeMode,
      setTripTime: s.setTripTime,
      setWaypointSchedule: s.setWaypointSchedule,
      applyWaypointOrder: s.applyWaypointOrder,
      setWaypoint: s.setWaypoint,
      addWaypoint: s.addWaypoint,
      removeWaypoint: s.removeWaypoint,
      reorderWaypoints: s.reorderWaypoints,
      reverseWaypoints: s.reverseWaypoints,
      setMode: s.setMode,
      setEvMode: s.setEvMode,
      setEvForceNonExclusive: s.setEvForceNonExclusive,
      setActiveRouteIndex: s.setActiveRouteIndex,
      setTransitItineraries: s.setTransitItineraries,
      setActiveItineraryIndex: s.setActiveItineraryIndex,
      setTransitDepartureTime: s.setTransitDepartureTime,
      setTransitArrivalTime: s.setTransitArrivalTime,
    })),
  );
  const transitTimeMode = transitOptions.timeMode;
  const { transitDepartureTime, transitArrivalTime } = transitOptions;
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

  const userLocation = useMapStore((s) => s.userLocation);
  const mapContext = useMapOptional();
  const registry = useIntegrationRegistry();
  const { services: caps } = useCapabilities();
  const optimizeMutation = useOptimizeRoute(CALLER_SHOWS_ERRORS);
  const ground = useGroundDirectionsPlan();
  const details = useDirectionsDetailsNavigation();

  const [showOptions, setShowOptions] = useState(false);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const [scheduleEditIndex, setScheduleEditIndex] = useState<number | null>(null);
  const [focusedField, setFocusedField] = useState<number | null>(null);
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const waypointListRef = useRef<HTMLDivElement>(null);

  const { values: inputValues, setDraft, clearDraft, hasDraft } = useWaypointDrafts(waypoints);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelBlur = useCallback(() => {
    if (blurTimeoutRef.current !== null) clearTimeout(blurTimeoutRef.current);
    blurTimeoutRef.current = null;
  }, []);
  useEffect(() => cancelBlur, [cancelBlur]);

  const myLocationLabel = t("myLocation");
  const requestFix = useForegroundLocation();
  // A fix that arrived while the origin held typed text. If that text is
  // emptied the fix still answers where the person is, so it fills the origin
  // then.
  const withheldFix = useRef<{ originId: string; location: LngLat } | null>(null);
  useEffect(() => {
    withheldFix.current = null;
    if (!isOpen) return;
    const requestedOrigin = useDirectionsStore.getState().waypoints[0];
    if (!requestedOrigin || requestedOrigin.coords !== null) return;

    let active = true;
    // Through the adapter, so the installed shell answers from the one location
    // producer it already owns rather than opening a second one.
    void requestFix({ maxAgeMs: 0 }).then((result) => {
      if (!active || result.status !== "ok") return;
      const directions = useDirectionsStore.getState();
      const origin = directions.waypoints[0];
      if (!directions.isOpen || origin?.id !== requestedOrigin.id || origin.coords !== null) return;
      const location: LngLat = [result.fix.lng, result.fix.lat];
      useMapStore.getState().setUserLocation(location);
      // Text being typed into the origin is the person's own choice of start.
      if (hasDraft(origin.id)) {
        withheldFix.current = { originId: origin.id, location };
        return;
      }
      setWaypoint(0, location, myLocationLabel);
    });

    return () => {
      active = false;
    };
  }, [isOpen, myLocationLabel, setWaypoint, requestFix, hasDraft]);

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

  const isTransitMode = mode === "transit";
  const isFlightMode = mode === "flying";
  // Ride mode plans the road route like driving; only its results area differs.
  const isRideMode = mode === "ride";
  // Rows that describe driving the route yourself (time picker, avoid options,
  // share, optimize) do not apply when someone else is doing the driving.
  const hidesRouteControls = isFlightMode || isRideMode;
  const { routeWaypoints, allWaypointsFilled, scheduleRequest, directionsQuery } = ground;
  const data = ground.directions.data;
  const scheduledData = ground.scheduled.data;

  const stopSearchRoute =
    isTimedGroundMode(mode) && data ? (data.routes[activeRouteIndex] ?? data.routes[0]) : undefined;
  // Under the route cards of a plain driving or motorcycle trip, with or
  // without stops; the EV, scheduled and ride branches never render it.
  const stopSearch =
    stopSearchRoute && data && (stopSearchRoute.geometry?.length ?? 0) >= 2 ? (
      <>
        <Divider />
        <RouteStopSearch
          route={stopSearchRoute}
          provider={data.provider}
          request={ground.groundRequest}
          units={units}
        />
      </>
    ) : null;

  const {
    queryIdentity: transitQueryIdentity,
    selectAlternative: selectTransitAlternative,
    isChained: transitIsChained,
    planQuery: transitPlanQuery,
    chainQuery: transitChainQuery,
    itineraries: transitItineraries,
    replanOptions: transitReplanOptions,
    attributions: transitPlanAttributions,
    paging: transitPaging,
    selectionToOpen: transitSelectionToOpen,
  } = useTransitDirectionsPlan({ enabled: isTransitMode, waypoints, ...transitOptions });
  const { openTransit } = details;
  useEffect(() => {
    if (transitSelectionToOpen)
      openTransit({
        identity: transitSelectionToOpen.queryIdentity,
        itinerary: transitSelectionToOpen.itinerary,
      });
  }, [transitSelectionToOpen, openTransit]);
  const transitPlanData = transitPlanQuery.data;
  const transitLoading = transitPlanQuery.isLoading;
  const transitPlan = planState(
    transitPlanQuery,
    (plan) =>
      transitItineraries.length === 0 || (plan.itineraries.length === 0 && !transitPaging.isPage),
  );
  const transitChain = planState(transitChainQuery, () => false);

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

  const detailsRoute =
    details.routeIndex !== null ? (ground.displayed?.routes[details.routeIndex] ?? null) : null;

  // Derive the visible text and its captured ownership together, once per button.
  const modeButtons = MODES.map((button) => {
    const isActive = mode === button.mode;
    const isTransit = button.mode === "transit";
    const cached = isTransit || button.disabled ? undefined : ground.cachedDuration(button.mode);
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
            time: formatDuration(record.duration, locale),
            contributors: contributorsForField(record, "duration"),
          }
        : cached;
    const loading = isActive && (isTransit ? transitLoading : directionsQuery.isLoading && !cached);
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
      const origin = waypoints[0];
      if (origin) clearDraft(origin.id);
      setWaypoint(0, userLocation, t("myLocation"));
    }
  }, [userLocation, waypoints, clearDraft, setWaypoint, t]);

  // The dropdown must outlive the blur long enough for a click on a suggestion,
  // but a pending blur belongs to the field that fired it, not the next one.
  const handleWaypointBlur = useCallback(() => {
    cancelBlur();
    blurTimeoutRef.current = setTimeout(() => {
      blurTimeoutRef.current = null;
      setFocusedField(null);
    }, 150);
  }, [cancelBlur]);

  // On a phone the stop card opens a full-screen search; on desktop the
  // suggestions open under the field.
  const handleWaypointFocus = useCallback(
    (index: number) => {
      cancelBlur();
      setFocusedField(index);
    },
    [cancelBlur],
  );

  const handleInputChange = useCallback(
    (index: number, value: string) => {
      const waypoint = waypoints[index];
      if (!waypoint) return;
      const withheld = withheldFix.current;
      if (value.trim() === "" && withheld?.originId === waypoint.id && waypoint.coords === null) {
        withheldFix.current = null;
        clearDraft(waypoint.id);
        setWaypoint(index, withheld.location, myLocationLabel);
        return;
      }
      if (value) {
        setDraft(waypoint, value);
        return;
      }
      clearDraft(waypoint.id);
      setWaypoint(index, null, "");
    },
    [waypoints, setDraft, clearDraft, setWaypoint, myLocationLabel],
  );

  const handleSuggestionSelect = (result: AutocompleteResult) => {
    if (!result.coordinates || focusedField === null) return;
    const { label, coordinates } = result;
    const waypoint = waypoints[focusedField];
    if (waypoint) clearDraft(waypoint.id);
    setWaypoint(focusedField, coordinates, label);
    cancelBlur();
    setFocusedField(null);
  };

  const handleRemove = useCallback(
    (index: number) => {
      const waypoint = waypoints[index];
      if (waypoint) clearDraft(waypoint.id);
      removeWaypoint(index);
    },
    [waypoints, clearDraft, removeWaypoint],
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
  const switchMode = (nextMode: TravelMode) => {
    setMode(nextMode);
    details.leave();
  };
  const recovery: RouteRecoveryActions = {
    onEditOrigin: () => focusWaypoint(0),
    onEditDestination: () => focusWaypoint(waypoints.length - 1),
    modes: fallbackModes,
    onSelectMode: (nextMode: GroundFallbackMode) => switchMode(nextMode),
  };

  const handleOptimize = useCallback(() => {
    if (routeWaypoints.length < 3) return;
    const requestedStops = waypoints;
    optimizeMutation.mutate(
      { waypoints: routeWaypoints, mode, ...routeOptions, units },
      {
        onSuccess: (result) => {
          if (!result.optimizedOrder) return;
          // The order answers the stops as they were when asked. If the user
          // moved, replaced or reordered a stop since, it no longer applies.
          if (!sameStops(requestedStops, useDirectionsStore.getState().waypoints)) return;
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
    waypoints,
    routeWaypoints,
    mode,
    routeOptions,
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

  const transitDetailsIndex =
    details.transit?.identity === transitQueryIdentity
      ? findTransitItinerary(transitItineraries, details.transit.itinerary)
      : -1;
  const transitDetailsItinerary = transitItineraries[transitDetailsIndex];
  if (transitDetailsIndex >= 0 && transitDetailsItinerary) {
    return (
      <AttributionDetailsGroup placement="footer" label={tc("dataSources")}>
        <TransitDetailsView
          itinerary={transitDetailsItinerary}
          isLowestCo2={
            lowestCo2Grams !== null && transitDetailsItinerary.co2Grams === lowestCo2Grams
          }
          originLabel={originLabel}
          destinationLabel={destinationLabel}
          provider={transitPlanData?.provider}
          attributions={snapshotContributors(transitDetailsItinerary.contributors ?? [])}
          originTimeZone={originTimeZone}
          destinationTimeZone={destinationTimeZone}
          onSelectItinerary={(parent, candidate) => {
            const selected = selectTransitAlternative(parent, candidate);
            if (selected) openTransit({ identity: transitQueryIdentity, itinerary: selected });
          }}
          onBack={details.closeTransit}
        />
      </AttributionDetailsGroup>
    );
  }

  if (detailsRoute) {
    return (
      <DetailsView
        route={detailsRoute}
        attributions={routeAttributions(registry, ground.displayed?.provider, detailsRoute)}
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        waypointLabels={waypoints.map((wp) => wp.label)}
        units={units}
        onBack={details.closeRoute}
      />
    );
  }

  // The depart/arrive picker is shared by transit and driving (driving uses
  // local state; transit uses the store). `activeTime*` adapt the shared
  // controlled picker to whichever flow is active.
  const showTimePicker = isTransitMode || isTimedGroundMode(mode);
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

  // A phone chooses a stop in the main full-screen search, as a search
  // that fills the stop instead of opening the place.
  const openStopSearch = (index: number) => {
    const waypoint = waypoints[index];
    if (!waypoint) return;
    useStopSearchStore.getState().open({
      initialQuery: inputValues[index] ?? "",
      placeholder: waypointPlaceholder(t, index, waypoints.length),
      onPick: ({ coordinates, label }) => {
        clearDraft(waypoint.id);
        setWaypoint(index, coordinates, label);
      },
    });
  };

  const suggestionList = (
    <>
      <AutocompleteDropdown
        suggestions={wsSuggestions ?? []}
        onSelect={handleSuggestionSelect}
        query={activeQuery}
        distanceReference={
          userLocation ? { kind: "user_location", coordinates: userLocation } : undefined
        }
      />
      {waypointAttributions.length > 0 && (
        <Box sx={{ px: 2, py: 0.75 }}>
          <AttributionStrip attributions={waypointAttributions} variant="plain" />
        </Box>
      )}
    </>
  );

  const waypointList = (
    <Box ref={waypointListRef}>
      <WaypointList
        waypoints={waypoints}
        inputValues={inputValues}
        onInputChange={handleInputChange}
        onFocus={handleWaypointFocus}
        onBlur={handleWaypointBlur}
        onReorder={reorderWaypoints}
        onAdd={addWaypoint}
        onRemove={handleRemove}
        onReverse={reverseWaypoints}
        onUseMyLocation={userLocation ? handleUseMyLocation : undefined}
        onEditSchedule={isEvMode || isFlightMode ? undefined : setScheduleEditIndex}
        isEvMode={isEvMode}
        onFieldPress={inSheet ? openStopSearch : undefined}
        t={t}
      />
    </Box>
  );

  // In a phone's sheet the driving switch and the departure time share a row.
  const timeInModeRow = inSheet && mode === "driving" && showTimePicker && !hidesRouteControls;
  const timed = activeTimeMode !== "now";
  // Leave now / depart at / arrive by, for transit and timed driving.
  const timeChip = (
    <ClickableRow
      aria-expanded={timePickerOpen}
      onClick={() => setTimePickerOpen((v) => !v)}
      sx={{
        width: "auto",
        gap: 0.75,
        px: 1.75,
        py: 0.75,
        borderRadius: "12px",
        bgcolor: timed ? `${BRAND}18` : "action.hover",
        "&:hover": { bgcolor: timed ? `${BRAND}28` : "action.selected" },
        transition: "background-color 0.15s",
      }}
    >
      <ScheduleIcon sx={{ fontSize: 18, color: timed ? BRAND : "text.primary" }} />
      <Typography variant="body2" color={timed ? BRAND : "text.primary"} sx={{ fontWeight: 500 }}>
        {activeTimeMode === "now"
          ? t("departNow")
          : activeTimeMode === "depart"
            ? `${t("departAt")} ${activeTimeValue ? fmt.time(activeTimeValue) : ""}`
            : `${t("arriveBy")} ${activeTimeValue ? fmt.time(activeTimeValue) : ""}`}
      </Typography>
      <ExpandMoreIcon sx={{ fontSize: 18, color: timed ? BRAND : "text.primary" }} />
    </ClickableRow>
  );

  const routingCredits = (
    <AttributionStrip
      attributions={ground.routingAttributions}
      variant="panel-header"
      label={tc("dataSources")}
    />
  );
  const routeCardImpact = (i: number) => ({
    impact: ground.impacts.impacts[i],
    impactUnavailableReason: ground.impacts.unavailableReason,
    vehicles: ground.impacts.compatibleVehicles,
    onUpdateAssumptions: ground.impacts.updateAssumptions,
  });

  const groundResults = scheduleRequest ? (
    <RouteResultStates state={ground.scheduled} recovery={recovery}>
      {scheduledData && (
        <>
          {scheduledData.routes.map((route, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: routes have no stable id
            <Box key={i}>
              <RouteCard
                route={route}
                index={i}
                active
                selectionKind="peek"
                isFastest={i === ground.fastestRouteIndex}
                onSelect={() => snapTo("peek")}
                onDetails={() => details.openRoute(i)}
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
                {...routeCardImpact(i)}
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
          {routingCredits}
        </>
      )}
    </RouteResultStates>
  ) : (
    <RouteResultStates state={ground.directions} recovery={recovery}>
      {data?.routes[0] &&
        (hasMultipleStops ? (
          <>
            <MultiStopRouteSummary
              route={data.routes[0]}
              waypoints={waypoints}
              units={units}
              onDetails={() => details.openRoute(0)}
            />
            {stopSearch}
            {routingCredits}
          </>
        ) : (
          <>
            <Box role="radiogroup" aria-label={t("routes")}>
              {data.routes.map((route, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: routes have no stable id
                <Box key={i}>
                  <RouteCard
                    route={route}
                    index={i}
                    active={i === activeRouteIndex}
                    isFastest={i === ground.fastestRouteIndex}
                    onSelect={() => {
                      setActiveRouteIndex(i);
                      snapTo("peek");
                    }}
                    onDetails={() => details.openRoute(i)}
                    units={units}
                    arrivalContext={ground.arrivalContext}
                    alternatives={data.routes.filter((_, idx) => idx !== i)}
                    provider={data.provider}
                    roadConditionImpact={data.roadConditionImpact}
                    {...routeCardImpact(i)}
                  />
                  {i < data.routes.length - 1 && <Divider />}
                </Box>
              ))}
            </Box>
            {stopSearch}
            {routingCredits}
          </>
        ))}
    </RouteResultStates>
  );

  const transitResults = (
    <RouteResultStates state={transitPlan} recovery={recovery}>
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
            onDetails={() => openTransit({ identity: transitQueryIdentity, itinerary: itin })}
            onRefreshed={(updated, changed, fallbackOccurred) => {
              const current = useDirectionsStore.getState().transitItineraries;
              if (!current.includes(itin)) return;
              const retained =
                !fallbackOccurred &&
                transitItineraryFingerprint(updated) === transitItineraryFingerprint(itin)
                  ? { ...updated, regionalOnly: itin.regionalOnly }
                  : updated;
              setTransitItineraries(
                current.map((candidate) => (candidate === itin ? retained : candidate)),
              );
              if (changed || fallbackOccurred) {
                setSnackbar(fallbackOccurred ? t("connectionReplanned") : t("connectionUpdated"));
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
    </RouteResultStates>
  );

  const results = isFlightMode ? (
    <FlightPanel />
  ) : isRideMode ? (
    <>
      {allWaypointsFilled && <RouteResultStates state={ground.directions} recovery={recovery} />}
      <RidePanel
        route={
          !directionsQuery.isError && data?.routes[0]
            ? { distanceMeters: data.routes[0].distance, durationSeconds: data.routes[0].duration }
            : undefined
        }
      />
    </>
  ) : !allWaypointsFilled ? (
    <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {t("chooseOrigin")}
      </Typography>
    </Box>
  ) : isEvMode ? (
    <>
      <EvVehiclePanel />
      {ground.evRequest && (
        <RouteResultStates state={ground.ev} recovery={recovery}>
          {ground.ev.data && (
            <EvPlanCard
              result={ground.ev.data}
              onRetryWithoutNetworkRestriction={() => setEvForceNonExclusive(true)}
            />
          )}
        </RouteResultStates>
      )}
    </>
  ) : transitIsChained ? (
    <RouteResultStates state={transitChain} recovery={recovery}>
      {transitChain.data && (
        <>
          {transitChain.data.segments.length === 0 && <NoRoutesFound actions={recovery} />}
          <TransitChainView
            plan={transitChain.data}
            waypointLabels={waypoints.map((wp) => wp.label)}
          />
        </>
      )}
    </RouteResultStates>
  ) : isTransitMode ? (
    transitResults
  ) : (
    groundResults
  );

  return (
    // Tapping the collapsed sheet's background opens it to mid. Keyboard users
    // change the sheet's height from the focusable sheet itself.
    // biome-ignore lint/plugin/noClickableLayoutElement: background tap, not an action
    <Box onClick={expandOnBackgroundTap}>
      {/* Keep panel actions separate so every travel mode gets the full panel width. */}
      <Box sx={{ display: "flex", alignItems: "center", px: 1, pt: 0.5 }}>
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
        {/* Route options and sharing live in the title row, not rows of their own. */}
        {!hidesRouteControls && (
          <Tooltip title={t("options")}>
            <IconButton
              size="small"
              aria-label={t("options")}
              aria-expanded={showOptions}
              onClick={() => setShowOptions((v) => !v)}
              sx={{
                width: 44,
                height: 44,
                flexShrink: 0,
                color: showOptions ? "primary.main" : undefined,
              }}
            >
              <TuneIcon sx={{ fontSize: 22 }} />
            </IconButton>
          </Tooltip>
        )}
        {!hidesRouteControls && allWaypointsFilled && (
          <Tooltip title={tp("share")}>
            <IconButton
              size="small"
              aria-label={tp("share")}
              onClick={handleShare}
              sx={{ width: 44, height: 44, flexShrink: 0 }}
            >
              <ShareIcon sx={{ fontSize: 22 }} />
            </IconButton>
          </Tooltip>
        )}
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
        {modeButtons.map(({ mode: m, icon, labelKey, disabled, isActive, time, loading }) => (
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
            onClick={() => switchMode(m)}
          />
        ))}
      </Box>
      {/* Driving sub-mode: normal route vs. EV charge planning. EV is a subtype
          of driving, not its own top-level mode, so it lives here rather than in
          the mode row. */}
      {mode === "driving" && (
        // Beside the panel the fields follow, so it lines up with them:
        // WaypointList's px (12px) + WaypointRow's 24px icon column + its 4px gap.
        // In a phone's sheet the fields float above the map; it lines up with
        // the sheet's content and keeps its distance from the divider below.
        <Box
          sx={[
            inSheet ? { px: 2, pt: 1, pb: 1.5 } : { pl: 5, pr: 1.5, pt: 1 },
            { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 },
          ]}
        >
          {/* Departure first, where transit has it too. */}
          {timeInModeRow && timeChip}
          <ToggleButtonGroup
            size="small"
            exclusive
            value={isEvMode ? "ev" : "route"}
            onChange={(_, value) => {
              if (!value) return;
              setEvMode(value === "ev");
              details.leave();
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
      {/* Waypoint list with drag-and-drop: in the panel, or above the map on a phone. */}
      {inSheet ? <PhoneWaypointCard>{waypointList}</PhoneWaypointCard> : waypointList}
      <Box sx={{ position: "relative" }}>
        <Divider />

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

        {/* Flight and ride modes render their own forms below, so this row is hidden. */}
        {!hidesRouteControls && showTimePicker && !timeInModeRow && (
          <Box sx={{ display: "flex", alignItems: "center", px: 2, py: 1 }}>{timeChip}</Box>
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

        <Divider />

        <AttributionDetailsGroup placement="footer" label={tc("dataSources")}>
          <AttributionStrip attributions={modeDurationAttributions} provenanceDisplay="details" />
          {results}
        </AttributionDetailsGroup>

        {showSuggestions && !inSheet && (
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
            {suggestionList}
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
