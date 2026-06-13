"use client";

import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MenuIcon from "@mui/icons-material/Menu";
import RouteIcon from "@mui/icons-material/Route";
import ScheduleIcon from "@mui/icons-material/Schedule";
import ShareIcon from "@mui/icons-material/Share";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import type {
  AutocompleteResult,
  DirectionsResult,
  LngLat,
  TransitReplanOptions,
  TravelMode,
} from "@openmapx/core";
import {
  applyDeutschlandticketFilter,
  formatDistance,
  formatDuration,
  preferredModesToMotis,
  rankItineraries,
  TRANSIT_ACCESS_MOTIS_MODES,
  useAutocomplete,
  useCapabilities,
  useDebounce,
  useDirections,
  useDirectionsStore,
  useMapStore,
  useMenuStore,
  useOptimizeRoute,
  useRouteInGermany,
  useSettingsStore,
  useSidebarStore,
  useTransitPlan,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { ChangeEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DetailsView } from "@/components/panels/directions/DetailsView";
import { FlightPanel } from "@/components/panels/directions/FlightPanel";
import { MODES, ModeButton } from "@/components/panels/directions/ModeSelector";
import { RouteCard } from "@/components/panels/directions/RouteCard";
import { RouteOptions } from "@/components/panels/directions/RouteOptions";
import { TransitDetailsView } from "@/components/panels/directions/TransitDetailsView";
import { TransitItineraryCard } from "@/components/panels/directions/TransitRouteView";
import { WaypointList } from "@/components/panels/directions/WaypointList";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { shareCurrentUrl } from "@/lib/deepLink";
import { TEAL } from "@/lib/theme";
import { useAttributionFromHooks } from "@/lib/useAttributionFromHooks";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";

function toDateTimeLocalString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DirectionsPanelContent() {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const tp = useTranslations("place");
  const locale = useLocale();
  const fmt = useDateTimeFormat();
  const {
    waypoints,
    origin,
    originLabel,
    destination,
    destinationLabel,
    mode,
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
    deutschlandticketOnly,
    setWaypoint,
    addWaypoint,
    removeWaypoint,
    reorderWaypoints,
    reverseWaypoints,
    setOrigin,
    setMode,
    setActiveRouteIndex,
    setTransitItineraries,
    setActiveItineraryIndex,
    setTransitDepartureTime,
    setTransitArrivalTime,
  } = useDirectionsStore();
  const units = useSettingsStore((s) => s.units);

  const { userLocation } = useMapStore();
  const registry = useIntegrationRegistry();
  const { services: caps } = useCapabilities();
  const queryClient = useQueryClient();
  const optimizeMutation = useOptimizeRoute();

  const [showOptions, setShowOptions] = useState(false);
  const [detailsRouteIndex, setDetailsRouteIndex] = useState<number | null>(null);
  const [transitDetailsIndex, setTransitDetailsIndex] = useState<number | null>(null);
  const [transitTimeMode, setTransitTimeMode] = useState<"now" | "depart" | "arrive">("now");
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const [numItineraries, setNumItineraries] = useState(3);
  const [focusedField, setFocusedField] = useState<number | null>(null);
  const [snackbar, setSnackbar] = useState<string | null>(null);

  const handleShare = async () => {
    const result = await shareCurrentUrl();
    if (result === "copied") setSnackbar(tp("linkCopied"));
  };

  // Per-waypoint input text (synced from store labels)
  const [inputValues, setInputValues] = useState<string[]>(() => waypoints.map((wp) => wp.label));

  // Sync input values when waypoints change externally
  useEffect(() => {
    setInputValues(waypoints.map((wp) => wp.label));
  }, [waypoints]);

  const isTransitMode = mode === "transit";
  const isFlightMode = mode === "flying";

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

  const { data, isLoading, isError } = useDirections({
    waypoints: isTransitMode || isFlightMode ? [] : allWaypointsFilled ? routeWaypoints : [],
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
  });

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

  const effectiveMotisModes = useMemo(() => {
    const base = preferredModesToMotis(transitPreferredModes);
    return deutschlandticketActive ? applyDeutschlandticketFilter(base) : base;
  }, [transitPreferredModes, deutschlandticketActive]);

  const accessModes = TRANSIT_ACCESS_MOTIS_MODES[transitAccessMode];

  // Snapshot of the resolved MOTIS options to hand to navigation, so an on-trip
  // replan reuses the same modes/access/wheelchair/D-Ticket gate the plan used.
  const transitReplanOptions = useMemo<TransitReplanOptions>(
    () => ({
      modes: effectiveMotisModes,
      wheelchair: transitRoutePreference === "wheelchair",
      preTransitModes: accessModes.preTransitModes,
      postTransitModes: accessModes.postTransitModes,
      directModes: accessModes.directModes,
    }),
    [effectiveMotisModes, transitRoutePreference, accessModes],
  );

  const transitPlanQuery = useTransitPlan({
    origin: isTransitMode ? origin : null,
    destination: isTransitMode ? destination : null,
    departAt: transitDepartAtStr,
    arriveBy: transitArriveByStr,
    numItineraries: effectiveNumItineraries,
    modes: effectiveMotisModes,
    wheelchair: transitRoutePreference === "wheelchair",
    preTransitModes: accessModes.preTransitModes,
    postTransitModes: accessModes.postTransitModes,
    directModes: accessModes.directModes,
  });
  const {
    data: transitPlanData,
    isLoading: transitLoading,
    isError: transitError,
  } = transitPlanQuery;
  const transitPlanAttributions = useAttributionFromHooks(transitPlanQuery);

  useEffect(() => {
    if (transitPlanData?.itineraries) {
      setTransitItineraries(rankItineraries(transitPlanData.itineraries, transitRoutePreference));
    }
  }, [transitPlanData, transitRoutePreference, setTransitItineraries]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger deps
  useEffect(() => {
    setNumItineraries(3);
  }, [origin, destination]);

  // Autocomplete for the currently focused waypoint input
  const activeQuery = focusedField !== null ? (inputValues[focusedField] ?? "") : "";
  const debouncedActiveQuery = useDebounce(activeQuery, 300);
  const { data: wsSuggestions } = useAutocomplete(debouncedActiveQuery, locale);
  const showSuggestions = focusedField !== null && (wsSuggestions?.length ?? 0) > 0;

  const detailsRoute =
    detailsRouteIndex !== null ? (data?.routes[detailsRouteIndex] ?? null) : null;

  const routingAttributions = useMemo<Attribution[]>(() => {
    function toAttributions(
      sources:
        | Array<{
            sourceId: string;
            name: string;
            url?: string;
            license?: string;
            licenseUrl?: string;
            attribution?: string;
          }>
        | undefined,
    ): Attribution[] {
      if (!sources) return [];
      return sources.map((s) => ({
        sourceId: s.sourceId,
        name: s.name,
        url: s.url,
        spdxLicense: s.license,
        licenseUrl: s.licenseUrl,
        attributionText: s.attribution,
      }));
    }
    if (data?.provider) {
      const meta = registry.get(data.provider);
      if (meta) return toAttributions(meta.dataSources);
    }
    const routingIntegrations = registry.getByDomain("routing").filter((r) => {
      const cap = caps[r.id];
      return cap ? cap.available && cap.healthy : false;
    });
    if (!routingIntegrations.length) return [];
    return toAttributions(routingIntegrations[0].dataSources);
  }, [registry, caps, data?.provider]);

  const getCachedTime = (m: TravelMode): string | undefined => {
    if (!allWaypointsFilled) return undefined;
    const waypointsStr = routeWaypoints.map(([lng, lat]) => `${lng},${lat}`).join(";");
    const cached = queryClient.getQueryData<DirectionsResult>([
      "directions",
      waypointsStr,
      m,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      units,
    ]);
    const duration = cached?.routes[0]?.duration;
    return duration !== undefined ? formatDuration(duration) : undefined;
  };

  const handleUseMyLocation = useCallback(() => {
    if (userLocation) {
      setOrigin(userLocation, t("myLocation"));
    }
  }, [userLocation, setOrigin, t]);

  const handleWaypointBlur = useCallback(() => {
    setTimeout(() => setFocusedField(null), 150);
  }, []);

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
  const showOptimize = hasMultipleStops && allWaypointsFilled && !isTransitMode && !isFlightMode;
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

  return (
    <Box>
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

        <Box sx={{ display: "flex", flex: 1, justifyContent: "space-around" }}>
          {MODES.map(({ mode: m, icon, labelKey, disabled }) => {
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
      {/* Waypoint list with drag-and-drop */}
      <WaypointList
        waypoints={waypoints}
        inputValues={inputValues}
        onInputChange={handleInputChange}
        onFocus={setFocusedField}
        onBlur={handleWaypointBlur}
        onReorder={reorderWaypoints}
        onAdd={handleAdd}
        onRemove={handleRemove}
        onReverse={handleReverse}
        onUseMyLocation={userLocation ? handleUseMyLocation : undefined}
        isTransitMode={isTransitMode}
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
                color: TEAL,
                cursor: "pointer",
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 0.75,
                px: 1.5,
                py: 0.5,
                borderRadius: 99,
                "&:hover": { bgcolor: `${TEAL}18` },
                transition: "background-color 0.15s",
              }}
            >
              {optimizeMutation.isPending ? (
                <>
                  <CircularProgress size={14} sx={{ color: TEAL }} />
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
        {!isFlightMode && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: isTransitMode ? "space-between" : "flex-end",
              px: 2,
              py: 1,
            }}
          >
            {isTransitMode && (
              <Box
                onClick={() => setTimePickerOpen((v) => !v)}
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 0.75,
                  px: 1.75,
                  py: 0.75,
                  borderRadius: "12px",
                  bgcolor: transitTimeMode !== "now" ? `${TEAL}18` : "action.hover",
                  cursor: "pointer",
                  "&:hover": {
                    bgcolor: transitTimeMode !== "now" ? `${TEAL}28` : "action.selected",
                  },
                  transition: "background-color 0.15s",
                }}
              >
                <ScheduleIcon
                  sx={{ fontSize: 18, color: transitTimeMode !== "now" ? TEAL : "text.primary" }}
                />
                <Typography
                  variant="body2"
                  color={transitTimeMode !== "now" ? TEAL : "text.primary"}
                  sx={{
                    fontWeight: 500,
                  }}
                >
                  {transitTimeMode === "now"
                    ? t("departNow")
                    : transitTimeMode === "depart"
                      ? `${t("departAt")} ${transitDepartureTime instanceof Date ? fmt.time(transitDepartureTime) : ""}`
                      : `${t("arriveBy")} ${transitArrivalTime instanceof Date ? fmt.time(transitArrivalTime) : ""}`}
                </Typography>
                <ExpandMoreIcon
                  sx={{ fontSize: 18, color: transitTimeMode !== "now" ? TEAL : "text.primary" }}
                />
              </Box>
            )}

            <Typography
              variant="body2"
              sx={{
                color: showOptions ? TEAL : "text.secondary",
                cursor: "pointer",
                fontWeight: 500,
                px: 1.5,
                py: 0.75,
                borderRadius: 99,
                "&:hover": { bgcolor: `${TEAL}18`, color: TEAL },
                transition: "background-color 0.15s, color 0.15s",
              }}
              onClick={() => setShowOptions((v) => !v)}
            >
              {isTransitMode ? t("routeOptions") : t("options")}
            </Typography>
          </Box>
        )}

        {/* Transit time picker dropdown */}
        {isTransitMode && timePickerOpen && (
          <Box sx={{ px: 2, pb: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
            <Box sx={{ display: "flex", gap: 0.5 }}>
              {(["now", "depart", "arrive"] as const).map((m) => (
                <Box
                  key={m}
                  onClick={() => {
                    setTransitTimeMode(m);
                    if (m === "now") {
                      setTransitDepartureTime("now");
                      setTransitArrivalTime(null);
                    } else if (m === "depart" && !(transitDepartureTime instanceof Date)) {
                      setTransitDepartureTime(new Date());
                    } else if (m === "arrive" && !transitArrivalTime) {
                      setTransitArrivalTime(new Date());
                    }
                  }}
                  sx={{
                    px: 1.5,
                    py: 0.5,
                    borderRadius: "8px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    bgcolor: transitTimeMode === m ? TEAL : "action.hover",
                    "&:hover": { bgcolor: transitTimeMode === m ? TEAL : "action.selected" },
                    transition: "background-color 0.15s",
                  }}
                >
                  <Typography
                    variant="caption"
                    color={transitTimeMode === m ? "#fff" : "text.primary"}
                    sx={{
                      fontWeight: 500,
                    }}
                  >
                    {m === "now" ? t("departNow") : m === "depart" ? t("departAt") : t("arriveBy")}
                  </Typography>
                </Box>
              ))}
            </Box>
            {transitTimeMode !== "now" && (
              <Box
                component="input"
                type="datetime-local"
                value={
                  (transitTimeMode === "depart"
                    ? transitDepartureTime
                    : transitArrivalTime) instanceof Date
                    ? toDateTimeLocalString(
                        (transitTimeMode === "depart"
                          ? transitDepartureTime
                          : transitArrivalTime) as Date,
                      )
                    : ""
                }
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const val = e.target.value;
                  if (!val) return;
                  const dt = new Date(val);
                  if (transitTimeMode === "depart") setTransitDepartureTime(dt);
                  else setTransitArrivalTime(dt);
                }}
                sx={{
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: "8px",
                  px: 1.5,
                  py: 0.75,
                  fontSize: "0.875rem",
                  fontFamily: "inherit",
                  color: "text.primary",
                  bgcolor: "background.paper",
                  outline: "none",
                  "&:focus": { borderColor: TEAL },
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            )}
          </Box>
        )}

        {showOptions && !isFlightMode && <RouteOptions />}

        {/* Share row — sits between the options row and the offered routes */}
        {!isFlightMode && allWaypointsFilled && (
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
                color: TEAL,
                cursor: "pointer",
                fontWeight: 500,
                fontFamily: "inherit",
                fontSize: "0.875rem",
                px: 1,
                py: 0.5,
                borderRadius: 99,
                "&:hover": { bgcolor: `${TEAL}18` },
                transition: "background-color 0.15s",
              }}
            >
              <ShareIcon sx={{ fontSize: 18 }} />
              {tp("share")}
            </Box>
          </Box>
        )}

        <Divider />

        {/* Route results */}
        {isFlightMode ? (
          <FlightPanel />
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
        ) : isTransitMode ? (
          transitLoading ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={28} sx={{ color: TEAL }} />
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
                    onSelect={() => setActiveItineraryIndex(i)}
                    onDetails={() => setTransitDetailsIndex(i)}
                  />
                  {i < transitItineraries.length - 1 && <Divider />}
                </Box>
              ))}
              {numItineraries < 9 && (
                <Box sx={{ px: 2, py: 1, borderTop: "1px solid", borderColor: "divider" }}>
                  <Typography
                    variant="body2"
                    sx={{
                      color: TEAL,
                      cursor: "pointer",
                      fontWeight: 500,
                      display: "inline-block",
                      "&:hover": { textDecoration: "underline" },
                    }}
                    onClick={() => setNumItineraries((n) => Math.min(n + 3, 9))}
                  >
                    {t("moreOptions")}
                  </Typography>
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
            <CircularProgress size={28} sx={{ color: TEAL }} />
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
                  borderLeft: `4px solid ${TEAL}`,
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
                      color: TEAL,
                      cursor: "pointer",
                      fontWeight: 500,
                      px: 1.5,
                      py: 0.75,
                      borderRadius: 99,
                      "&:hover": { bgcolor: `${TEAL}18` },
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
                  onSelect={() => setActiveRouteIndex(i)}
                  onDetails={() => setDetailsRouteIndex(i)}
                  units={units}
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
    </Box>
  );
}
