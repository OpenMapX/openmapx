"use client";

import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import MenuIcon from "@mui/icons-material/Menu";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { AutocompleteResult, DirectionsResult, TravelMode } from "@openmapx/core";
import {
  formatDuration,
  resolveProvider,
  useAutocomplete,
  useDebounce,
  useDirections,
  useDirectionsStore,
  useMapStore,
  useMenuStore,
  useProviders,
  useSidebarStore,
  useTransitPlan,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { ChangeEvent } from "react";
import { useEffect, useState } from "react";
import { DetailsView } from "@/components/panels/directions/DetailsView";
import { MODES, ModeButton } from "@/components/panels/directions/ModeSelector";
import { RouteCard } from "@/components/panels/directions/RouteCard";
import { RouteOptions } from "@/components/panels/directions/RouteOptions";
import { TransitDetailsView } from "@/components/panels/directions/TransitDetailsView";
import { TransitItineraryCard } from "@/components/panels/directions/TransitRouteView";
import { WaypointInput } from "@/components/panels/directions/WaypointInput";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { TEAL } from "@/lib/theme";

/** Formats a Date to the value expected by `<input type="datetime-local">`. */
function toDateTimeLocalString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DirectionsPanelContent() {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const locale = useLocale();
  const {
    origin,
    originLabel,
    destination,
    destinationLabel,
    mode,
    activeRouteIndex,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
    transitItineraries,
    activeItineraryIndex,
    transitDepartureTime,
    transitArrivalTime,
    setOrigin,
    setDestination,
    swapOriginDestination,
    setMode,
    setActiveRouteIndex,
    setTransitItineraries,
    setActiveItineraryIndex,
    setTransitDepartureTime,
    setTransitArrivalTime,
  } = useDirectionsStore();

  const { userLocation } = useMapStore();
  const { data: providers } = useProviders();
  const queryClient = useQueryClient();

  const [showOptions, setShowOptions] = useState(false);
  const [detailsRouteIndex, setDetailsRouteIndex] = useState<number | null>(null);
  const [transitDetailsIndex, setTransitDetailsIndex] = useState<number | null>(null);
  const [transitTimeMode, setTransitTimeMode] = useState<"now" | "depart" | "arrive">("now");
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const [numItineraries, setNumItineraries] = useState(3);
  const [originInput, setOriginInput] = useState(originLabel);
  const [destInput, setDestInput] = useState(destinationLabel);
  const [focusedField, setFocusedField] = useState<"origin" | "destination" | null>(null);

  // Sync local inputs when store labels change (e.g. panel opened with pre-filled destination)
  useEffect(() => {
    setOriginInput(originLabel);
  }, [originLabel]);
  useEffect(() => {
    setDestInput(destinationLabel);
  }, [destinationLabel]);

  const isTransitMode = mode === "transit";

  const { data, isLoading, isError } = useDirections({
    origin: isTransitMode ? null : origin,
    destination: isTransitMode ? null : destination,
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
  });

  // Transit plan query — debounce time inputs so rapid adjustments don't fire immediately
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

  const {
    data: transitPlanData,
    isLoading: transitLoading,
    isError: transitError,
  } = useTransitPlan({
    origin: isTransitMode ? origin : null,
    destination: isTransitMode ? destination : null,
    departAt: transitDepartAtStr,
    arriveBy: transitArriveByStr,
    numItineraries,
  });

  // Sync transit itineraries to store
  useEffect(() => {
    if (transitPlanData?.itineraries) {
      setTransitItineraries(transitPlanData.itineraries);
    }
  }, [transitPlanData, setTransitItineraries]);

  // Reset itinerary count when origin/destination change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger deps
  useEffect(() => {
    setNumItineraries(3);
  }, [origin, destination]);

  // Autocomplete for the currently focused waypoint input
  const activeQuery = focusedField === "origin" ? originInput : destInput;
  const debouncedActiveQuery = useDebounce(activeQuery, 300);
  const { data: wsSuggestions } = useAutocomplete(debouncedActiveQuery, locale);
  const showSuggestions = focusedField !== null && (wsSuggestions?.length ?? 0) > 0;

  const detailsRoute =
    detailsRouteIndex !== null ? (data?.routes[detailsRouteIndex] ?? null) : null;

  // Read cached result for any mode without triggering a new fetch
  const getCachedTime = (m: TravelMode): string | undefined => {
    if (!origin || !destination) return undefined;
    const cached = queryClient.getQueryData<DirectionsResult>([
      "directions",
      origin,
      destination,
      m,
      avoidHighways,
      avoidTolls,
      avoidFerries,
      units,
    ]);
    const duration = cached?.routes[0]?.duration;
    return duration !== undefined ? formatDuration(duration) : undefined;
  };

  const handleUseMyLocation = () => {
    if (userLocation) {
      setOrigin(userLocation, t("myLocation"));
      setOriginInput(t("myLocation"));
    }
  };

  // Delay blur so a click on a suggestion fires before the list closes
  const handleWaypointBlur = () => setTimeout(() => setFocusedField(null), 150);

  const handleSuggestionSelect = (result: AutocompleteResult) => {
    if (!result.coordinates) return;
    const { label, coordinates } = result;
    if (focusedField === "origin") {
      setOriginInput(label);
      setOrigin(coordinates, label);
    } else {
      setDestInput(label);
      setDestination(coordinates, label);
    }
    setFocusedField(null);
  };

  if (transitDetailsIndex !== null && transitItineraries[transitDetailsIndex]) {
    return (
      <TransitDetailsView
        itinerary={transitItineraries[transitDetailsIndex]}
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        provider={transitPlanData?.provider}
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

        {/* Mode buttons */}
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

      {/* Waypoint inputs */}
      <Box sx={{ px: 1.5, pt: 0.75, pb: 0.5 }}>
        <Box sx={{ display: "flex", alignItems: "stretch", gap: 1 }}>
          {/* Dot / line / pin column */}
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "space-around",
              pt: 1.25,
              pb: 1.25,
              flexShrink: 0,
            }}
          >
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                border: "2px solid",
                borderColor: "text.secondary",
              }}
            />
            <Box sx={{ display: "flex", flexDirection: "column", gap: "3px", my: 0.5 }}>
              {[0, 1, 2].map((i) => (
                <Box
                  key={i}
                  sx={{ width: 3, height: 3, borderRadius: "50%", bgcolor: "text.disabled" }}
                />
              ))}
            </Box>
            <LocationOnIcon sx={{ fontSize: 18, color: "#EA4335" }} />
          </Box>

          {/* Input boxes */}
          <Box sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0 }}>
            <Box
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: "8px",
                bgcolor: "grey.50",
                "&:focus-within": {
                  borderColor: TEAL,
                  bgcolor: "background.paper",
                  boxShadow: `0 0 0 2px ${TEAL}22`,
                },
                transition: "box-shadow 0.15s",
              }}
            >
              <WaypointInput
                value={originInput}
                placeholder={t("chooseOrigin")}
                onChange={(v) => {
                  setOriginInput(v);
                  if (!v) setOrigin(null, "");
                }}
                onUseMyLocation={userLocation ? handleUseMyLocation : undefined}
                onFocus={() => setFocusedField("origin")}
                onBlur={handleWaypointBlur}
                useMyLocationLabel={t("useMyLocation")}
              />
            </Box>
            <Box
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: "8px",
                bgcolor: "grey.50",
                "&:focus-within": {
                  borderColor: TEAL,
                  bgcolor: "background.paper",
                  boxShadow: `0 0 0 2px ${TEAL}22`,
                },
                transition: "box-shadow 0.15s",
              }}
            >
              <WaypointInput
                value={destInput}
                placeholder={t("chooseDestination")}
                onChange={(v) => {
                  setDestInput(v);
                  if (!v) setDestination(null, "");
                }}
                onFocus={() => setFocusedField("destination")}
                onBlur={handleWaypointBlur}
              />
            </Box>
          </Box>

          {/* Swap button */}
          <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <IconButton
              size="small"
              onClick={() => {
                swapOriginDestination();
                const tmp = originInput;
                setOriginInput(destInput);
                setDestInput(tmp);
              }}
            >
              <SwapVertIcon sx={{ fontSize: 22 }} />
            </IconButton>
          </Box>
        </Box>

        {/* Add destination */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            mt: 0.5,
            py: 0.75,
            px: 0.25,
            cursor: "pointer",
            color: "text.secondary",
            "&:hover": { color: TEAL },
          }}
        >
          <AddCircleOutlineIcon sx={{ fontSize: 18, ml: 0 }} />
          <Typography variant="body2">{t("addStop")}</Typography>
        </Box>
      </Box>

      {/* Divider + content below (suggestions overlay anchors here) */}
      <Box sx={{ position: "relative" }}>
        <Divider />

        {/* Leave now / Depart at / Arrive by + Options */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            px: 2,
            py: 1,
          }}
        >
          {/* Time mode pill */}
          <Box
            onClick={() => setTimePickerOpen((v) => !v)}
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.75,
              px: 1.75,
              py: 0.75,
              borderRadius: "12px",
              bgcolor: transitTimeMode !== "now" ? `${TEAL}18` : "grey.100",
              cursor: "pointer",
              "&:hover": { bgcolor: transitTimeMode !== "now" ? `${TEAL}28` : "grey.200" },
              transition: "background-color 0.15s",
            }}
          >
            <ScheduleIcon
              sx={{ fontSize: 18, color: transitTimeMode !== "now" ? TEAL : "text.primary" }}
            />
            <Typography
              variant="body2"
              fontWeight={500}
              color={transitTimeMode !== "now" ? TEAL : "text.primary"}
            >
              {transitTimeMode === "now"
                ? t("departNow")
                : transitTimeMode === "depart"
                  ? `${t("departAt")} ${transitDepartureTime instanceof Date ? transitDepartureTime.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : ""}`
                  : `${t("arriveBy")} ${transitArrivalTime instanceof Date ? transitArrivalTime.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : ""}`}
            </Typography>
            <ExpandMoreIcon
              sx={{ fontSize: 18, color: transitTimeMode !== "now" ? TEAL : "text.primary" }}
            />
          </Box>

          {!isTransitMode && (
            <Typography
              variant="body2"
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
              onClick={() => setShowOptions((v) => !v)}
            >
              {t("options")}
            </Typography>
          )}
        </Box>

        {/* Transit time picker dropdown */}
        {isTransitMode && timePickerOpen && (
          <Box sx={{ px: 2, pb: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
            {/* Mode selector */}
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
                    bgcolor: transitTimeMode === m ? TEAL : "grey.100",
                    "&:hover": { bgcolor: transitTimeMode === m ? TEAL : "grey.200" },
                    transition: "background-color 0.15s",
                  }}
                >
                  <Typography
                    variant="caption"
                    fontWeight={500}
                    color={transitTimeMode === m ? "#fff" : "text.primary"}
                  >
                    {m === "now" ? t("departNow") : m === "depart" ? t("departAt") : t("arriveBy")}
                  </Typography>
                </Box>
              ))}
            </Box>
            {/* Date+time input */}
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

        {showOptions && !isTransitMode && <RouteOptions />}

        <Divider />

        {/* Route results */}
        {!origin || !destination ? (
          <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
            <Typography variant="body2" color="text.secondary">
              {t("chooseOrigin")}
            </Typography>
          </Box>
        ) : isTransitMode ? (
          // Transit itineraries
          transitLoading ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={28} sx={{ color: TEAL }} />
            </Box>
          ) : transitError ? (
            <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
              <Typography variant="body2" color="error.main">
                {t("transitNotAvailable")}
              </Typography>
            </Box>
          ) : transitItineraries.length === 0 ? (
            <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
              <Typography variant="body2" color="text.secondary">
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
              {transitPlanData?.provider &&
                (() => {
                  const attr = resolveProvider(providers, transitPlanData.provider ?? "");
                  return (
                    <Box sx={{ px: 2, py: 1.5, borderTop: "1px solid", borderColor: "divider" }}>
                      <Typography variant="caption" color="text.disabled">
                        {tc("data")}:{" "}
                        {attr.url ? (
                          <Link
                            href={attr.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            color="inherit"
                            underline="hover"
                          >
                            {attr.label}
                          </Link>
                        ) : (
                          attr.label
                        )}
                        {attr.license &&
                          (attr.licenseUrl ? (
                            <>
                              {" ("}
                              <Link
                                href={attr.licenseUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                color="inherit"
                                underline="hover"
                              >
                                {attr.license}
                              </Link>
                              {")"}
                            </>
                          ) : (
                            ` (${attr.license})`
                          ))}
                      </Typography>
                    </Box>
                  );
                })()}
            </>
          )
        ) : isLoading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={28} sx={{ color: TEAL }} />
          </Box>
        ) : isError ? (
          <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
            <Typography variant="body2" color="error.main">
              {t("noRoutesFound")}
            </Typography>
          </Box>
        ) : (
          data?.routes.map((route, i) => (
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
          ))
        )}

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
      {/* end position:relative wrapper */}
    </Box>
  );
}
