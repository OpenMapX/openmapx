"use client";

import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FlightIcon from "@mui/icons-material/Flight";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import MenuIcon from "@mui/icons-material/Menu";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { AutocompleteResult, DirectionsResult, Route, TravelMode } from "@openmapx/core";
import {
  formatDistance,
  formatDuration,
  useAutocomplete,
  useDirections,
  useDirectionsStore,
  useMapStore,
  usePlaceStore,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";

const PANEL_WIDTH = 400;
const TEAL = "#007b8b";

// ─── Mode button config ───────────────────────────────────────────────────────

const MODES: { mode: TravelMode; icon: ReactNode; label: string; disabled?: boolean }[] = [
  { mode: "driving", icon: <DirectionsCarIcon sx={{ fontSize: 22 }} />, label: "Driving" },
  {
    mode: "transit",
    icon: <DirectionsBusIcon sx={{ fontSize: 22 }} />,
    label: "Transit",
    disabled: true,
  },
  { mode: "walking", icon: <DirectionsWalkIcon sx={{ fontSize: 22 }} />, label: "Walking" },
  { mode: "cycling", icon: <DirectionsBikeIcon sx={{ fontSize: 22 }} />, label: "Cycling" },
  {
    mode: "flying" as TravelMode,
    icon: <FlightIcon sx={{ fontSize: 22 }} />,
    label: "Flights",
    disabled: true,
  },
];

// ─── Mode button (icon + time, circle bg when active) ────────────────────────

function ModeButton({
  icon,
  label,
  time,
  active,
  disabled,
  loading,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  time?: string;
  active: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip title={label} placement="bottom" arrow>
      <Box
        onClick={disabled ? undefined : onClick}
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0.4,
          px: 0.75,
          py: 0.5,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.35 : 1,
          borderRadius: 1,
          "&:hover": {},
          minWidth: 44,
        }}
      >
        {/* Icon inside pill */}
        <Box
          sx={{
            px: 1.5,
            height: 32,
            borderRadius: 99,
            bgcolor: active ? "#a9dde9" : "#fff",
            "&:hover": active ? {} : { bgcolor: "grey.100" },
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background-color 0.15s",
            "& svg": {
              fontSize: 22,
              color: "text.primary",
              transition: "color 0.15s",
            },
          }}
        >
          {icon}
        </Box>

        {/* Time label below icon */}
        <Box sx={{ height: 14, display: "flex", alignItems: "center" }}>
          {loading ? (
            <CircularProgress size={10} sx={{ color: "text.disabled" }} />
          ) : (
            <Typography
              variant="caption"
              sx={{
                fontSize: 11,
                lineHeight: 1,
                color: active ? TEAL : "text.secondary",
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                maxWidth: 44,
                textOverflow: "ellipsis",
              }}
            >
              {time ?? ""}
            </Typography>
          )}
        </Box>
      </Box>
    </Tooltip>
  );
}

// ─── Waypoint input ───────────────────────────────────────────────────────────

function WaypointInput({
  value,
  placeholder,
  onChange,
  onUseMyLocation,
  onFocus,
  onBlur,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onUseMyLocation?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", px: 1.25, py: 0.625 }}>
      <Box
        component="input"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        sx={{
          flex: 1,
          border: "none",
          outline: "none",
          fontSize: 14,
          color: "text.primary",
          bgcolor: "transparent",
          minWidth: 0,
          "::placeholder": { color: "text.secondary" },
        }}
      />
      {onUseMyLocation && (
        <Tooltip title="Use my location">
          <IconButton
            size="small"
            onClick={onUseMyLocation}
            sx={{ color: TEAL, p: 0.25, flexShrink: 0 }}
          >
            <MyLocationIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

// ─── Route card ───────────────────────────────────────────────────────────────

function RouteCard({
  route,
  index,
  active,
  onSelect,
  onDetails,
  units,
}: {
  route: Route;
  index: number;
  active: boolean;
  onSelect: () => void;
  onDetails: () => void;
  units: "metric" | "imperial";
}) {
  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

  const modeIcon =
    route.mode === "driving" ? (
      <DirectionsCarIcon sx={{ fontSize: 22, color: active ? TEAL : "text.disabled" }} />
    ) : route.mode === "walking" ? (
      <DirectionsWalkIcon sx={{ fontSize: 22, color: active ? TEAL : "text.disabled" }} />
    ) : (
      <DirectionsBikeIcon sx={{ fontSize: 22, color: active ? TEAL : "text.disabled" }} />
    );

  return (
    <Box
      onClick={onSelect}
      sx={{
        display: "flex",
        gap: 1.5,
        px: 2,
        py: 1.5,
        cursor: "pointer",
        borderLeft: active ? `4px solid ${TEAL}` : "4px solid transparent",
        bgcolor: active ? "rgba(0,123,139,0.04)" : "transparent",
        "&:hover": { bgcolor: active ? "rgba(0,123,139,0.07)" : "action.hover" },
        transition: "background-color 0.15s",
      }}
    >
      <Box sx={{ flexShrink: 0, mt: 0.25 }}>{modeIcon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Typography
            variant="body2"
            fontWeight={600}
            color="text.primary"
            noWrap
            sx={{ flex: 1, mr: 1 }}
          >
            {route.summary ?? "Best route"}
          </Typography>
          <Typography
            variant="body2"
            fontWeight={600}
            color={active ? TEAL : "text.primary"}
            sx={{ flexShrink: 0 }}
          >
            {formatDuration(route.duration)}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary">
          {dist}
        </Typography>
        {active && index === 0 && (
          <Typography variant="caption" color="text.secondary" display="block">
            Fastest route
          </Typography>
        )}
        {active && (
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
                onDetails();
              }}
            >
              Details
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ─── Step row ─────────────────────────────────────────────────────────────────

function StepRow({
  instruction,
  distance,
  duration,
  units,
}: {
  instruction: string;
  distance: number;
  duration: number;
  units: "metric" | "imperial";
}) {
  const dist =
    units === "imperial" ? `${(distance / 1609.34).toFixed(1)} mi` : formatDistance(distance);

  return (
    <Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 1.5,
          px: 2,
          py: 1,
        }}
      >
        <Box sx={{ flexShrink: 0, color: "text.secondary", mt: 0.25 }}>
          <ChevronRightIcon sx={{ fontSize: 18 }} />
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography variant="body2">{instruction}</Typography>
        </Box>
      </Box>
      <Box sx={{ pl: 6, pr: 2, pb: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          {formatDuration(duration)} ({dist})
        </Typography>
        <Divider sx={{ mt: 0.5 }} />
      </Box>
    </Box>
  );
}

// ─── Details view ─────────────────────────────────────────────────────────────

function DetailsView({
  route,
  originLabel,
  destinationLabel,
  units,
  onBack,
}: {
  route: Route;
  originLabel: string;
  destinationLabel: string;
  units: "metric" | "imperial";
  onBack: () => void;
}) {
  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 1.5, pt: 2, pb: 1 }}>
        <IconButton size="small" onClick={onBack} sx={{ mt: 0.25, flexShrink: 0 }}>
          <ArrowBackIcon sx={{ fontSize: 20 }} />
        </IconButton>
        <Box>
          <Typography variant="caption" color="text.secondary">
            from{" "}
            <Box component="span" fontWeight={600} color="text.primary">
              {originLabel || "Origin"}
            </Box>
          </Typography>
          <br />
          <Typography variant="caption" color="text.secondary">
            to{" "}
            <Box component="span" fontWeight={600} color="text.primary">
              {destinationLabel || "Destination"}
            </Box>
          </Typography>
        </Box>
      </Box>
      <Divider />
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="h6" fontWeight={600} color="success.main" component="span">
          {formatDuration(route.duration)}{" "}
        </Typography>
        <Typography variant="body1" color="text.secondary" component="span">
          ({dist})
        </Typography>
        {route.summary && (
          <Typography variant="body2" color="text.secondary" display="block">
            {route.summary}
          </Typography>
        )}
      </Box>
      <Divider />
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="body2" fontWeight={700}>
          {originLabel || "Origin"}
        </Typography>
      </Box>
      {route.steps.map((step, i) => (
        <StepRow
          // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id
          key={i}
          instruction={step.instruction}
          distance={step.distance}
          duration={step.duration}
          units={units}
        />
      ))}
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="body2" fontWeight={700}>
          {destinationLabel || "Destination"}
        </Typography>
      </Box>
    </Box>
  );
}

// ─── Options panel ────────────────────────────────────────────────────────────

function OptionsPanel() {
  const {
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
    setAvoidHighways,
    setAvoidTolls,
    setAvoidFerries,
    setUnits,
  } = useDirectionsStore();

  function CheckRow({
    label,
    checked,
    onChange,
  }: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
  }) {
    return (
      <Box
        onClick={() => onChange(!checked)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          py: 0.5,
          cursor: "pointer",
          "&:hover": { color: TEAL },
        }}
      >
        {checked ? (
          <CheckBoxIcon sx={{ fontSize: 20, color: TEAL }} />
        ) : (
          <CheckBoxOutlineBlankIcon sx={{ fontSize: 20, color: "text.secondary" }} />
        )}
        <Typography variant="body2">{label}</Typography>
      </Box>
    );
  }

  function RadioRow({
    label,
    selected,
    onSelect,
  }: {
    label: string;
    selected: boolean;
    onSelect: () => void;
  }) {
    return (
      <Box
        onClick={onSelect}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          py: 0.5,
          cursor: "pointer",
          "&:hover": { color: TEAL },
        }}
      >
        {selected ? (
          <RadioButtonCheckedIcon sx={{ fontSize: 20, color: TEAL }} />
        ) : (
          <RadioButtonUncheckedIcon sx={{ fontSize: 20, color: "text.secondary" }} />
        )}
        <Typography variant="body2">{label}</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ px: 2, pb: 1.5 }}>
      <Divider sx={{ mb: 1.5, mx: -2 }} />
      <Box sx={{ display: "flex", gap: 4 }}>
        <Box sx={{ flex: 1 }}>
          <Typography
            variant="caption"
            fontWeight={600}
            color="text.secondary"
            sx={{ textTransform: "uppercase", letterSpacing: 0.5 }}
          >
            Avoid
          </Typography>
          <CheckRow label="Highways" checked={avoidHighways} onChange={setAvoidHighways} />
          <CheckRow label="Tolls" checked={avoidTolls} onChange={setAvoidTolls} />
          <CheckRow label="Ferries" checked={avoidFerries} onChange={setAvoidFerries} />
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography
            variant="caption"
            fontWeight={600}
            color="text.secondary"
            sx={{ textTransform: "uppercase", letterSpacing: 0.5 }}
          >
            Distance
          </Typography>
          <RadioRow
            label="Kilometres"
            selected={units === "metric"}
            onSelect={() => setUnits("metric")}
          />
          <RadioRow
            label="Miles"
            selected={units === "imperial"}
            onSelect={() => setUnits("imperial")}
          />
        </Box>
      </Box>
    </Box>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function DirectionsPanel() {
  const {
    isOpen,
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
    close,
    setOrigin,
    setDestination,
    swapOriginDestination,
    setMode,
    setActiveRouteIndex,
  } = useDirectionsStore();

  const { userLocation } = useMapStore();
  const { setSidePanelCollapsed } = usePlaceStore();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setSidePanelCollapsed(collapsed);
  }, [collapsed, setSidePanelCollapsed]);

  useEffect(() => {
    return () => setSidePanelCollapsed(false);
  }, [setSidePanelCollapsed]);
  const [showOptions, setShowOptions] = useState(false);
  const [detailsRouteIndex, setDetailsRouteIndex] = useState<number | null>(null);
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

  const { data, isLoading, isError } = useDirections({
    origin,
    destination,
    mode,
    avoidHighways,
    avoidTolls,
    avoidFerries,
    units,
  });

  // Autocomplete for the currently focused waypoint input
  const activeQuery = focusedField === "origin" ? originInput : destInput;
  const { data: wsSuggestions } = useAutocomplete(activeQuery);
  const showSuggestions = focusedField !== null && (wsSuggestions?.length ?? 0) > 0;

  if (!isOpen) return null;

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
      setOrigin(userLocation, "My Location");
      setOriginInput("My Location");
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

  return (
    <>
      <Paper
        elevation={0}
        sx={{
          position: "absolute",
          bottom: { xs: 0, sm: "auto" },
          top: { xs: "auto", sm: 0 },
          left: 0,
          right: { xs: 0, sm: "auto" },
          width: { xs: "100%", sm: PANEL_WIDTH },
          height: { xs: "auto", sm: "100dvh" },
          maxHeight: { xs: "80dvh", sm: "none" },
          overflowY: "auto",
          borderRadius: { xs: "16px 16px 0 0", sm: 0 },
          boxShadow: { xs: 6, sm: "4px 0 12px rgba(0,0,0,0.15)" },
          zIndex: 9,
          transform: { sm: collapsed ? "translateX(-100%)" : "translateX(0)" },
          transition: { sm: "transform 0.25s ease" },
        }}
      >
        {detailsRoute ? (
          <DetailsView
            route={detailsRoute}
            originLabel={originLabel}
            destinationLabel={destinationLabel}
            units={units}
            onBack={() => setDetailsRouteIndex(null)}
          />
        ) : (
          <Box>
            {/* ── Top row: hamburger | mode buttons | close ── */}
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
              <IconButton size="small" sx={{ mt: 1, ml: 0.5, mr: 0.5, flexShrink: 0 }}>
                <MenuIcon sx={{ fontSize: 22 }} />
              </IconButton>

              {/* Mode buttons */}
              <Box sx={{ display: "flex", flex: 1, justifyContent: "space-around" }}>
                {MODES.map(({ mode: m, icon, label, disabled }) => {
                  const isActive = mode === m;
                  const timeStr = disabled
                    ? undefined
                    : isActive
                      ? data?.routes[0]?.duration !== undefined
                        ? formatDuration(data.routes[0].duration)
                        : getCachedTime(m)
                      : getCachedTime(m);
                  const modeLoading = isActive && isLoading && !getCachedTime(m);
                  return (
                    <ModeButton
                      key={m}
                      icon={icon}
                      label={label}
                      time={timeStr}
                      active={isActive}
                      disabled={disabled}
                      loading={modeLoading}
                      onClick={() => {
                        setMode(m);
                        setDetailsRouteIndex(null);
                      }}
                    />
                  );
                })}
              </Box>

              <IconButton
                size="small"
                onClick={close}
                sx={{ mt: 1, ml: 0.5, mr: 1, flexShrink: 0 }}
                aria-label="Close directions"
              >
                <CloseIcon sx={{ fontSize: 22 }} />
              </IconButton>
            </Box>

            {/* ── Waypoint inputs ── */}
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
                <Box
                  sx={{ flex: 1, display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0 }}
                >
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
                      placeholder="Choose starting point"
                      onChange={(v) => {
                        setOriginInput(v);
                        if (!v) setOrigin(null, "");
                      }}
                      onUseMyLocation={userLocation ? handleUseMyLocation : undefined}
                      onFocus={() => setFocusedField("origin")}
                      onBlur={handleWaypointBlur}
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
                      placeholder="Choose destination"
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
                <Typography variant="body2">Add destination</Typography>
              </Box>
            </Box>

            {/* ── Divider + content below (suggestions overlay anchors here) ── */}
            <Box sx={{ position: "relative" }}>
              <Divider />

              {/* ── Leave now + Options ── */}
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  px: 2,
                  py: 1,
                }}
              >
                {/* Pill button */}
                <Box
                  sx={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 0.75,
                    px: 1.75,
                    py: 0.75,
                    borderRadius: "12px",
                    bgcolor: "grey.100",
                    cursor: "pointer",
                    "&:hover": { bgcolor: "grey.200" },
                    transition: "background-color 0.15s",
                  }}
                >
                  <ScheduleIcon sx={{ fontSize: 18, color: "text.primary" }} />
                  <Typography variant="body2" fontWeight={500}>
                    Leave now
                  </Typography>
                  <ExpandMoreIcon sx={{ fontSize: 18, color: "text.primary" }} />
                </Box>

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
                  Options
                </Typography>
              </Box>

              {showOptions && <OptionsPanel />}

              <Divider />

              {/* ── Route results ── */}
              {!origin || !destination ? (
                <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
                  <Typography variant="body2" color="text.secondary">
                    Enter a starting point and destination to get directions
                  </Typography>
                </Box>
              ) : isLoading ? (
                <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                  <CircularProgress size={28} sx={{ color: TEAL }} />
                </Box>
              ) : isError ? (
                <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
                  <Typography variant="body2" color="error.main">
                    Could not get directions. Please try again.
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

              {/* ── Suggestions overlay ── */}
              {showSuggestions && (
                <Box
                  sx={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bgcolor: "background.paper",
                    zIndex: 2,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
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
        )}
      </Paper>

      {/* Desktop collapse toggle */}
      <Tooltip title={collapsed ? "Show sidebar" : "Hide sidebar"} placement="right">
        <IconButton
          onClick={() => setCollapsed((c) => !c)}
          size="small"
          sx={{
            display: { xs: "none", sm: "flex" },
            alignItems: "center",
            justifyContent: "center",
            position: "absolute",
            top: "50%",
            left: collapsed ? 0 : PANEL_WIDTH,
            transform: "translateY(-50%)",
            transition: "left 0.25s ease",
            zIndex: 9,
            bgcolor: "background.paper",
            borderRadius: "0 6px 6px 0",
            boxShadow: "2px 2px 8px rgba(0,0,0,0.15)",
            width: 20,
            height: 48,
            padding: 0,
            "&:hover": { bgcolor: "grey.50" },
          }}
          aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {collapsed ? (
            <ChevronRightIcon sx={{ fontSize: 16 }} />
          ) : (
            <ChevronLeftIcon sx={{ fontSize: 16 }} />
          )}
        </IconButton>
      </Tooltip>
    </>
  );
}
