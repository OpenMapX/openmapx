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
import type {
  AutocompleteResult,
  DirectionsResult,
  LngLat,
  TransitReplanOptions,
  TravelMode,
} from "@openmapx/core";
import {
  directionsQueryKey,
  formatDistance,
  formatDuration,
  preferredModesToMotis,
  rankItineraries,
  TRANSIT_ACCESS_MOTIS_MODES,
  TRANSIT_ACCESS_RENTAL_FORM_FACTORS,
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
  useRouteInGermany,
  useSession,
  useSettingsStore,
  useSidebarStore,
  useTransitPlan,
  useTransitPlanningCapabilities,
  viewerTimeZone,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DetailsView } from "@/components/panels/directions/DetailsView";
import { EvPlanCard } from "@/components/panels/directions/EvPlanCard";
import { EvVehiclePanel } from "@/components/panels/directions/EvVehiclePanel";
import { FlightPanel } from "@/components/panels/directions/FlightPanel";
import { MODES, ModeButton } from "@/components/panels/directions/ModeSelector";
import { RidePanel } from "@/components/panels/directions/RidePanel";
import { RouteCard } from "@/components/panels/directions/RouteCard";
import { RouteOptions } from "@/components/panels/directions/RouteOptions";
import { ShareRouteDialog } from "@/components/panels/directions/ShareRouteDialog";
import {
  type TimeMode,
  TimeModePicker,
  toDateTimeLocalString,
} from "@/components/panels/directions/TimeModePicker";
import { TransitDetailsView } from "@/components/panels/directions/TransitDetailsView";
import { TransitItineraryCard } from "@/components/panels/directions/TransitRouteView";
import { WaypointList } from "@/components/panels/directions/WaypointList";
import { useExpandOnBackgroundTap, useMobileSheet } from "@/components/panels/sheet/sheetState";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { attributionsForProviders } from "@/lib/attributionForProviders";
import { buildEvDirectionsRequest } from "@/lib/buildEvDirectionsRequest";
import { shareCurrentUrl } from "@/lib/deepLink";
import { useForegroundLocation } from "@/lib/mobile/useForegroundLocation";
import { BRAND } from "@/lib/theme";
import { useAttributionFromHooks } from "@/lib/useAttributionFromHooks";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";

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
    transitItineraries,
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
    bikeHillPreference,
    deutschlandticketOnly,
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
  const evCustomVehicle = useSettingsStore((s) => s.evCustomVehicle);
  const evSocTargetPct = useSettingsStore((s) => s.evSocTargetPct);
  const evPreferredNetworks = useSettingsStore((s) => s.evPreferredNetworks);
  const evAvoidedNetworks = useSettingsStore((s) => s.evAvoidedNetworks);
  const evExclusiveNetworks = useSettingsStore((s) => s.evExclusiveNetworks);
  const evPreferCheaper = useSettingsStore((s) => s.evPreferCheaper);
  const evHomePricePerKwh = useSettingsStore((s) => s.evHomePricePerKwh);
  const evHomeCurrency = useSettingsStore((s) => s.evHomeCurrency);

  const { userLocation } = useMapStore();
  const registry = useIntegrationRegistry();
  const { services: caps } = useCapabilities();
  const queryClient = useQueryClient();
  const optimizeMutation = useOptimizeRoute();
  const { data: transitPlanningCapabilities } = useTransitPlanningCapabilities();

  const [showOptions, setShowOptions] = useState(false);
  const [detailsRouteIndex, setDetailsRouteIndex] = useState<number | null>(null);
  const [transitDetailsIndex, setTransitDetailsIndex] = useState<number | null>(null);
  const [transitTimeMode, setTransitTimeMode] = useState<"now" | "depart" | "arrive">("now");
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  // Driving depart/arrive is kept independent of the transit time state so the
  // two flows never interfere.
  const [drivingTimeMode, setDrivingTimeMode] = useState<TimeMode>("now");
  const [drivingTime, setDrivingTime] = useState<Date | null>(null);
  const [numItineraries, setNumItineraries] = useState(3);
  const [transitPageToken, setTransitPageToken] = useState<string | undefined>();
  const [transitPageDirection, setTransitPageDirection] = useState<"previous" | "next">("next");
  const [focusedField, setFocusedField] = useState<number | null>(null);
  const [snackbar, setSnackbar] = useState<string | null>(null);

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
  const debouncedDrivingTime = useDebounce(drivingTime, 500);
  const drivingDepartAtStr =
    isDrivingTimeMode && drivingTimeMode === "depart" && debouncedDrivingTime instanceof Date
      ? toDateTimeLocalString(debouncedDrivingTime)
      : undefined;
  const drivingArriveByStr =
    isDrivingTimeMode && drivingTimeMode === "arrive" && debouncedDrivingTime instanceof Date
      ? toDateTimeLocalString(debouncedDrivingTime)
      : undefined;

  const { data, isLoading, isError } = useDirections({
    waypoints:
      isTransitMode || isFlightMode || isEvMode ? [] : allWaypointsFilled ? routeWaypoints : [],
    mode: routeMode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    avoidClosures: avoidIncidents,
    units,
    lang: locale,
    departAt: drivingDepartAtStr,
    arriveBy: drivingArriveByStr,
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
        customVehicle: evCustomVehicle,
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
      evCustomVehicle,
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
  const { data: evData, isLoading: evLoading, isError: evIsError } = useEvDirections(evRequest);

  // Transit plan query
  const debouncedDepartureTime = useDebounce(transitDepartureTime, 500);
  const debouncedArrivalTime = useDebounce(transitArrivalTime, 500);
  const transitDepartAtStr =
    isTransitMode && transitTimeMode === "depart" && debouncedDepartureTime instanceof Date
      ? debouncedDepartureTime.toISOString()
      : undefined;
  const transitArriveByStr =
    isTransitMode && transitTimeMode === "arrive" && debouncedArrivalTime instanceof Date
      ? debouncedArrivalTime.toISOString()
      : undefined;

  // "Fewer transfers" / "Less walking" re-rank the returned Pareto front, so
  // fetch a few extra alternatives to give the sort something to choose from.
  const ranksClientSide =
    transitRoutePreference === "fewerTransfers" || transitRoutePreference === "lessWalking";
  const effectiveNumItineraries = ranksClientSide ? Math.max(numItineraries, 5) : numItineraries;

  // The Deutschlandticket filter is Germany-only; gate it on both endpoints
  // resolving to DE so we never silently constrain a route that leaves Germany.
  // Only resolve the endpoints' country when the toggle is actually on —
  // bothInGermany is consumed solely by deutschlandticketActive below, so an
  // off toggle must not fire two reverse-geocodes per transit route. (The
  // options panel resolves it separately to decide whether to show the toggle.)
  const { bothInGermany } = useRouteInGermany(
    isTransitMode && deutschlandticketOnly ? origin : null,
    isTransitMode && deutschlandticketOnly ? destination : null,
  );
  const deutschlandticketActive = isTransitMode && bothInGermany && deutschlandticketOnly;

  // Send the user's raw Prefer selection plus a Deutschlandticket flag; each
  // transit provider applies the D-Ticket restriction its own (most accurate)
  // way server-side (MOTIS intersects modes, db-vendo uses DB's native filter).
  const effectiveMotisModes = useMemo(
    () => preferredModesToMotis(transitPreferredModes),
    [transitPreferredModes],
  );

  const accessModes = TRANSIT_ACCESS_MOTIS_MODES[transitAccessMode];
  const rentalFormFactors = TRANSIT_ACCESS_RENTAL_FORM_FACTORS[transitAccessMode];
  const activePlanningMetadata = transitPlanningCapabilities?.providers.find(
    (provider) => provider.id === "transit-motis-local",
  )?.metadata;

  // Snapshot of the resolved MOTIS options to hand to navigation, so an on-trip
  // replan reuses the same modes/access/wheelchair/D-Ticket gate the plan used.
  const transitReplanOptions = useMemo<TransitReplanOptions>(
    () => ({
      modes: effectiveMotisModes,
      wheelchairRequired,
      maxTransfers: maxTransfers ?? undefined,
      transferBuffer,
      requireBikeTransport,
      bikeHillPreference,
      preTransitModes: accessModes.preTransitModes,
      postTransitModes: accessModes.postTransitModes,
      directModes: accessModes.directModes,
      deutschlandticketOnly: deutschlandticketActive,
    }),
    [
      effectiveMotisModes,
      wheelchairRequired,
      maxTransfers,
      transferBuffer,
      requireBikeTransport,
      bikeHillPreference,
      accessModes,
      deutschlandticketActive,
    ],
  );

  const transitPlanQuery = useTransitPlan({
    origin: isTransitMode ? origin : null,
    destination: isTransitMode ? destination : null,
    departAt: transitDepartAtStr,
    arriveBy: transitArriveByStr,
    numItineraries: effectiveNumItineraries,
    modes: effectiveMotisModes,
    wheelchairRequired,
    maxTransfers: maxTransfers ?? undefined,
    transferBuffer,
    requireBikeTransport,
    bikeHillPreference,
    rentalFormFactors,
    capabilityEpoch: activePlanningMetadata?.datasetEpoch,
    rentalSource: rentalFormFactors ? activePlanningMetadata?.source : undefined,
    rentalInstance: rentalFormFactors ? activePlanningMetadata?.instance : undefined,
    preTransitModes: accessModes.preTransitModes,
    postTransitModes: accessModes.postTransitModes,
    directModes: accessModes.directModes,
    deutschlandticketOnly: deutschlandticketActive,
    pageToken: transitPageToken,
  });
  const {
    data: transitPlanData,
    isLoading: transitLoading,
    isError: transitError,
  } = transitPlanQuery;
  const transitPlanAttributions = useAttributionFromHooks(transitPlanQuery);

  useEffect(() => {
    if (transitPlanData?.itineraries) {
      const incoming = transitPlanData.itineraries;
      const existing = transitPageToken ? useDirectionsStore.getState().transitItineraries : [];
      const combined =
        transitPageToken && transitPageDirection === "previous"
          ? [...incoming, ...existing]
          : [...existing, ...incoming];
      const seen = new Set<string>();
      const deduped = combined.filter((itinerary) => {
        const fallback = `${itinerary.startTime}|${itinerary.endTime}|${itinerary.legs
          .map((leg) => `${leg.tripId ?? leg.mode}:${leg.from.stopId ?? leg.from.name}`)
          .join("|")}`;
        const key = `${itinerary.source ?? transitPlanData.provider ?? "unknown"}:${
          itinerary.id ?? fallback
        }`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setTransitItineraries(rankItineraries(deduped, transitRoutePreference));
    }
  }, [
    transitPlanData,
    transitRoutePreference,
    setTransitItineraries,
    transitPageToken,
    transitPageDirection,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger deps
  useEffect(() => {
    setNumItineraries(3);
    setTransitPageToken(undefined);
  }, [origin, destination]);

  // Autocomplete for the currently focused waypoint input
  const activeQuery = focusedField !== null ? (inputValues[focusedField] ?? "") : "";
  const debouncedActiveQuery = useDebounce(activeQuery, 300);
  const { data: wsSuggestions } = useAutocomplete(debouncedActiveQuery, locale);
  const showSuggestions = focusedField !== null && (wsSuggestions?.length ?? 0) > 0;

  const detailsRoute =
    detailsRouteIndex !== null ? (data?.routes[detailsRouteIndex] ?? null) : null;

  const routingAttributions = useMemo<Attribution[]>(() => {
    // Credit the routing engine that actually served the route. `data.provider`
    // is the integration id stamped on every successful response (see
    // integrations/routing/index.ts). Only when it is somehow absent AND the
    // deployment has a single healthy routing provider — i.e. the served engine
    // is unambiguous — do we fall back to it; with several healthy engines we
    // credit none rather than guess the wrong one (OSM stays credited by the
    // always-on base-map control regardless).
    if (data?.provider) {
      return attributionsForProviders(registry, [data.provider]);
    }
    const healthy = registry.getByDomain("routing").filter((r) => {
      const cap = caps[r.id];
      return cap ? cap.available && cap.healthy : false;
    });
    return healthy.length === 1 ? attributionsForProviders(registry, [healthy[0].id]) : [];
  }, [registry, caps, data?.provider]);

  const getCachedTime = (m: TravelMode): string | undefined => {
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
        avoidClosures: avoidIncidents,
        units,
        lang: locale,
        departAt: m === "driving" ? drivingDepartAtStr : undefined,
        arriveBy: m === "driving" ? drivingArriveByStr : undefined,
      }),
    );
    const duration = cached?.routes[0]?.duration;
    return duration !== undefined ? formatDuration(duration) : undefined;
  };

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

  const handleOptimize = useCallback(() => {
    if (routeWaypoints.length < 3) return;
    optimizeMutation.mutate(
      {
        waypoints: routeWaypoints,
        mode,
        avoidHighways,
        avoidTolls,
        avoidFerries,
        units,
      },
      {
        onSuccess: (result) => {
          if (result.optimizedOrder) {
            const order = result.optimizedOrder;
            const currentWps = useDirectionsStore.getState().waypoints;
            const reordered = order.map((i) => currentWps[i]);
            for (let i = 0; i < reordered.length; i++) {
              const wp = reordered[i];
              setWaypoint(i, wp.coords, wp.label);
            }
            setSnackbar(t("routeOptimized"));
          }
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
    units,
    optimizeMutation,
    setWaypoint,
    t,
  ]);

  const hasMultipleStops = waypoints.length > 2;
  const showOptimize =
    hasMultipleStops && allWaypointsFilled && !isTransitMode && !hidesRouteControls;
  const lowestCo2Grams = useMemo(() => {
    const values = transitItineraries
      .map((itinerary) => itinerary.co2Grams)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length < 2) return null;
    return Math.min(...values);
  }, [transitItineraries]);

  if (transitDetailsIndex !== null && transitItineraries[transitDetailsIndex]) {
    return (
      <TransitDetailsView
        itinerary={transitItineraries[transitDetailsIndex]}
        isLowestCo2={
          lowestCo2Grams !== null &&
          transitItineraries[transitDetailsIndex]?.co2Grams === lowestCo2Grams
        }
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        provider={transitPlanData?.provider}
        attributions={transitPlanAttributions}
        originTimeZone={originTimeZone}
        destinationTimeZone={destinationTimeZone}
        onBack={() => setTransitDetailsIndex(null)}
      />
    );
  }

  if (detailsRoute) {
    return (
      <DetailsView
        route={detailsRoute}
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
  const activeTimeMode: TimeMode = isTransitMode ? transitTimeMode : drivingTimeMode;
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
    : drivingTime;
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
      setDrivingTimeMode(m);
      if (m !== "now" && !drivingTime) setDrivingTime(new Date());
    }
  };
  const handleTimeValueChange = (d: Date) => {
    if (isTransitMode) {
      if (transitTimeMode === "depart") setTransitDepartureTime(d);
      else setTransitArrivalTime(d);
    } else {
      setDrivingTime(d);
    }
  };

  return (
    // Tapping the collapsed sheet's background opens it to mid.
    <Box onClick={expandOnBackgroundTap}>
      {/* Top row: hamburger | mode buttons | close */}
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          pl: 2,
          pr: 0.5,
          pt: 1.5,
          pb: 0.25,
          gap: 0,
        }}
      >
        <IconButton
          size="small"
          aria-label={t("menu")}
          onClick={() => useMenuStore.getState().open()}
          sx={{ mt: 1, ml: 0.5, mr: 0.5, flexShrink: 0 }}
        >
          <MenuIcon sx={{ fontSize: 22 }} />
        </IconButton>

        <Box
          sx={{
            display: "flex",
            flex: 1,
            // Let this flex child shrink below its content so an over-wide set
            // of mode buttons scrolls here instead of widening the panel.
            minWidth: 0,
            justifyContent: "space-around",
            flexWrap: "nowrap",
            overflowX: "auto",
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": { display: "none" },
          }}
        >
          {MODES.map(({ mode: m, icon, labelKey, disabled }) => {
            // EV is a sub-option of driving (isEvMode), so the driving button
            // stays highlighted while EV planning is active — isEvMode only ever
            // coexists with mode === "driving".
            const isActive = mode === m;
            const isTransit = m === "transit";
            const timeStr = disabled
              ? undefined
              : isTransit
                ? isActive && transitItineraries[0]?.duration !== undefined
                  ? formatDuration(transitItineraries[0].duration)
                  : undefined
                : isActive
                  ? data?.routes[0]?.duration !== undefined
                    ? formatDuration(data.routes[0].duration)
                    : getCachedTime(m)
                  : getCachedTime(m);
            const modeLoading =
              isActive && (isTransit ? transitLoading : isLoading && !getCachedTime(m));
            return (
              <ModeButton
                key={m}
                icon={icon}
                label={t(labelKey)}
                time={timeStr}
                active={isActive}
                disabled={disabled}
                loading={modeLoading}
                onClick={() => {
                  setMode(m);
                  setDetailsRouteIndex(null);
                  setTransitDetailsIndex(null);
                }}
              />
            );
          })}
        </Box>

        <IconButton
          size="small"
          onClick={() => useSidebarStore.getState().closeSidebar()}
          sx={{ mt: 1, ml: 0.5, mr: 1, flexShrink: 0 }}
          aria-label={t("close")}
        >
          <CloseIcon sx={{ fontSize: 22 }} />
        </IconButton>
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
        isTransitMode={isTransitMode}
        isEvMode={isEvMode}
        t={t}
      />
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
              variant="body2"
              onClick={handleOptimize}
              sx={{
                color: BRAND,
                cursor: "pointer",
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 0.75,
                px: 1.5,
                py: 0.5,
                borderRadius: 99,
                "&:hover": { bgcolor: `${BRAND}18` },
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
        {isFlightMode ? (
          <FlightPanel />
        ) : isRideMode ? (
          <RidePanel
            route={
              data?.routes[0]
                ? {
                    distanceMeters: data.routes[0].distance,
                    durationSeconds: data.routes[0].duration,
                  }
                : undefined
            }
          />
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
            {!evVehicleId ? null : evLoading ? (
              <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                <CircularProgress size={28} sx={{ color: BRAND }} />
              </Box>
            ) : evIsError ? (
              <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
                <Typography variant="body2" sx={{ color: "error.main" }}>
                  {t("noRoutesFound")}
                </Typography>
              </Box>
            ) : evData ? (
              <EvPlanCard
                result={evData}
                onRetryWithoutNetworkRestriction={() => setEvForceNonExclusive(true)}
              />
            ) : null}
          </>
        ) : isTransitMode ? (
          transitLoading ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={28} sx={{ color: BRAND }} />
            </Box>
          ) : transitError ? (
            <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
              <Typography
                variant="body2"
                sx={{
                  color: "error.main",
                }}
              >
                {t("transitNotAvailable")}
              </Typography>
            </Box>
          ) : transitItineraries.length === 0 ? (
            <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                {t("noRoutesFound")}
              </Typography>
            </Box>
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
              {(transitPlanData?.previousPageToken || transitPlanData?.nextPageToken) && (
                <Box sx={{ px: 2, py: 1, borderTop: "1px solid", borderColor: "divider" }}>
                  <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
                    <Button
                      size="small"
                      disabled={!transitPlanData.previousPageToken || transitLoading}
                      onClick={() => {
                        setTransitPageDirection("previous");
                        setTransitPageToken(transitPlanData.previousPageToken);
                      }}
                    >
                      {t("earlierConnections")}
                    </Button>
                    <Button
                      size="small"
                      disabled={!transitPlanData.nextPageToken || transitLoading}
                      onClick={() => {
                        setTransitPageDirection("next");
                        setTransitPageToken(transitPlanData.nextPageToken);
                      }}
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
        ) : isLoading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={28} sx={{ color: BRAND }} />
          </Box>
        ) : isError ? (
          <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
            <Typography
              variant="body2"
              sx={{
                color: "error.main",
              }}
            >
              {t("noRoutesFound")}
            </Typography>
          </Box>
        ) : hasMultipleStops && data?.routes[0] ? (
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
                  sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}
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
        ) : data?.routes.length ? (
          <>
            {data.routes.map((route, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: routes have no stable id
              <Box key={i}>
                <RouteCard
                  route={route}
                  index={i}
                  active={i === activeRouteIndex}
                  onSelect={() => {
                    setActiveRouteIndex(i);
                    snapTo("peek");
                  }}
                  onDetails={() => setDetailsRouteIndex(i)}
                  units={units}
                  alternatives={data.routes.filter((_, idx) => idx !== i)}
                  provider={data.provider}
                />
                {i < data.routes.length - 1 && <Divider />}
              </Box>
            ))}
            <AttributionStrip
              attributions={routingAttributions}
              variant="panel-header"
              label={tc("dataSources")}
            />
          </>
        ) : null}

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
    </Box>
  );
}
