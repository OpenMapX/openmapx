"use client";

import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsBoatIcon from "@mui/icons-material/DirectionsBoat";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import FlightIcon from "@mui/icons-material/Flight";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import MenuIcon from "@mui/icons-material/Menu";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SubwayIcon from "@mui/icons-material/Subway";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type {
  AutocompleteResult,
  DirectionsResult,
  MergedDeparture,
  Place,
  Route,
  TravelMode,
  TripItinerary,
  TripLeg,
} from "@openmapx/core";
import {
  formatDistance,
  formatDuration,
  resolveProvider,
  useAutocomplete,
  useDebounce,
  useDirections,
  useDirectionsStore,
  useMapStore,
  usePlaceStore,
  useProviders,
  useTransitPlan,
  useVehicleJourney,
} from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { LegAlerts } from "@/components/panels/transit/LegAlerts";
import { RemarkChip } from "@/components/panels/transit/RemarkChip";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { TransitLegStops } from "@/components/panels/transit/TransitLegStops";
import { TripDetailView } from "@/components/panels/transit/TripDetailView";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { SidebarCollapseToggle } from "@/components/ui/SidebarCollapseToggle";
import { formatTime } from "@/lib/formatTime";
import { geocodeStopAsPlace } from "@/lib/geocodeStopAsPlace";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMap } from "@/lib/MapContext";
import { TEAL } from "@/lib/theme";

/** Formats a Date to the value expected by `<input type="datetime-local">`. */
function toDateTimeLocalString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Mode button config

const MODES: { mode: TravelMode; icon: ReactNode; label: string; disabled?: boolean }[] = [
  { mode: "driving", icon: <DirectionsCarIcon sx={{ fontSize: 22 }} />, label: "Driving" },
  {
    mode: "transit",
    icon: <DirectionsBusIcon sx={{ fontSize: 22 }} />,
    label: "Transit",
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

// Mode button (icon + time, circle bg when active)

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

// Waypoint input

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

// Route card

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

// Step row

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

// Details view

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

// Options panel

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

// Transit itinerary card

function LegBadge({ leg }: { leg: TripLeg }) {
  if (leg.mode === "walking") {
    return <DirectionsWalkIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
  }
  if (leg.route) {
    return (
      <RouteBadge
        shortName={leg.route.shortName}
        color={leg.route.color}
        mode={leg.mode}
        size="small"
      />
    );
  }
  return <DirectionsBusIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
}

function TransitItineraryCard({
  itinerary,
  active,
  onSelect,
  onDetails,
}: {
  itinerary: TripItinerary;
  active: boolean;
  onSelect: () => void;
  onDetails: () => void;
}) {
  const startTime = new Date(itinerary.startTime).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const endTime = new Date(itinerary.endTime).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Box
      onClick={onSelect}
      sx={{
        px: 2,
        py: 1.5,
        cursor: "pointer",
        borderLeft: active ? `4px solid ${TEAL}` : "4px solid transparent",
        bgcolor: active ? "rgba(0,123,139,0.04)" : "transparent",
        "&:hover": { bgcolor: active ? "rgba(0,123,139,0.07)" : "action.hover" },
        transition: "background-color 0.15s",
      }}
    >
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <DirectionsTransitIcon sx={{ fontSize: 18, color: active ? TEAL : "text.disabled" }} />
          <Typography variant="body2" fontWeight={600}>
            {startTime} – {endTime}
          </Typography>
        </Box>
        <Typography variant="body2" fontWeight={600} color={active ? TEAL : "text.primary"}>
          {formatDuration(itinerary.duration)}
        </Typography>
      </Box>

      {/* Leg summary */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.75, flexWrap: "wrap" }}>
        {itinerary.legs.map((leg, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
          <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            {i > 0 && <ChevronRightIcon sx={{ fontSize: 14, color: "text.disabled" }} />}
            <LegBadge leg={leg} />
          </Box>
        ))}
      </Box>

      {itinerary.transfers > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {itinerary.transfers} transfer{itinerary.transfers !== 1 ? "s" : ""}
          {itinerary.walkDistance > 0 && ` · ${formatDistance(itinerary.walkDistance)} walk`}
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
  );
}

// Trip remarks from vehicle journey data

function LegRemarks({ tripId }: { tripId: string }) {
  const { data: journey } = useVehicleJourney(tripId);
  if (!journey?.remarks?.length) return null;
  return (
    <Box sx={{ mt: 0.5, display: "flex", flexDirection: "column", gap: 0.25 }}>
      {journey.remarks.map((remark, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static ordered remark list
        <RemarkChip key={i} remark={remark} inline />
      ))}
    </Box>
  );
}

// Live badge — only rendered when vehicle journey data is actually available

function TransitLiveBadge({ tripId }: { tripId: string }) {
  const { data: journey } = useVehicleJourney(tripId);
  // Only show "Live" when at least one stop has actual realtime delay data
  const hasRealtime = journey?.stops?.some((s) => s.delaySeconds !== undefined);
  if (!hasRealtime) return null;
  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.4,
        px: 0.75,
        py: 0.25,
        borderRadius: 99,
        bgcolor: `${TEAL}1a`,
      }}
    >
      <Box sx={{ width: 5, height: 5, borderRadius: "50%", bgcolor: "#4caf50", flexShrink: 0 }} />
      <Typography variant="caption" fontWeight={600} sx={{ color: TEAL, fontSize: 10 }}>
        Live
      </Typography>
    </Box>
  );
}

// Inline delay chip shown next to a boarding/alighting stop

/**
 * Renders the time for a boarding/alighting stop with live delay info.
 * Shows realtime (delay-adjusted) time in red when delayed, otherwise scheduled time in grey.
 * The +Xm chip is shown below the time.
 */
function LiveStopTime({
  scheduledTime,
  tripId,
  stopId,
}: {
  scheduledTime: string;
  tripId?: string;
  stopId?: string;
}) {
  const { data: journey } = useVehicleJourney(tripId ?? null);
  const stop = stopId ? journey?.stops.find((s) => s.stopId === stopId) : undefined;
  const delayMin = stop ? Math.round((stop.delaySeconds ?? 0) / 60) : 0;
  const hasDelay = delayMin > 0;

  // Show realtime time when delayed
  const displayTime =
    hasDelay && stop
      ? formatTime(
          stop.expectedDeparture ??
            stop.expectedArrival ??
            stop.scheduledDeparture ??
            stop.scheduledArrival ??
            scheduledTime,
        )
      : scheduledTime;

  return (
    <>
      <Typography variant="caption" color={hasDelay ? "error.main" : "text.secondary"}>
        {displayTime}
      </Typography>
      {hasDelay && (
        <Typography
          variant="caption"
          fontWeight={600}
          sx={{ display: "block", color: "error.main", fontSize: "0.7rem" }}
        >
          +{delayMin}m
        </Typography>
      )}
    </>
  );
}

// Transit details view

function legToMergedDeparture(leg: TripLeg, provider?: string): MergedDeparture {
  return {
    tripId: leg.tripId ?? "",
    route: {
      id: leg.routeId ?? "",
      shortName: leg.route?.shortName ?? "",
      longName: leg.route?.longName ?? "",
      mode: leg.mode,
      color: leg.route?.color,
    },
    headsign: leg.to.name,
    scheduledAt: leg.startTime,
    providers: provider ? [provider] : [],
  };
}

function TransitDetailsView({
  itinerary,
  originLabel,
  destinationLabel,
  provider,
  onBack,
}: {
  itinerary: TripItinerary;
  originLabel: string;
  destinationLabel: string;
  provider?: string;
  onBack: () => void;
}) {
  const { data: providers } = useProviders();
  const [activeLegDep, setActiveLegDep] = useState<MergedDeparture | null>(null);
  const { setSelectedPlace } = usePlaceStore();
  const { flyTo } = useMap();

  function handleStopClick(name: string, lat: number, lng: number, stopId?: string) {
    flyTo([lng, lat], 16);
    void geocodeStopAsPlace({ id: stopId ?? "", name, lat, lng, modes: [], provider: "" }).then(
      (place) => {
        setSelectedPlace(
          place ??
            ({
              id: stopId || `place:${name}`,
              name,
              address: name,
              coordinates: [lng, lat],
            } as Place),
        );
      },
    );
  }
  const startTime = new Date(itinerary.startTime).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const endTime = new Date(itinerary.endTime).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (activeLegDep) {
    return <TripDetailView departure={activeLegDep} onBack={() => setActiveLegDep(null)} />;
  }

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

      {/* Summary */}
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="h6" fontWeight={600} component="span">
          {startTime} – {endTime}{" "}
        </Typography>
        <Typography variant="body1" color="text.secondary" component="span">
          ({formatDuration(itinerary.duration)})
        </Typography>
        {/* Leg badges summary */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.75, flexWrap: "wrap" }}>
          {itinerary.legs.map((leg, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
            <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              {i > 0 && <ChevronRightIcon sx={{ fontSize: 14, color: "text.disabled" }} />}
              <LegBadge leg={leg} />
            </Box>
          ))}
        </Box>
      </Box>
      <Divider />

      {/* Timeline */}
      <Box sx={{ pl: 1, pr: 2, py: 1 }}>
        {itinerary.legs.map((leg, i) => {
          const legStartTime = new Date(leg.startTime).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          const legEndTime = new Date(leg.endTime).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
          const isWalk = leg.mode === "walking";
          const legColor = isWalk
            ? "#757575"
            : leg.route?.color
              ? `#${leg.route.color.replace("#", "")}`
              : TEAL;
          const duration =
            (new Date(leg.endTime).getTime() - new Date(leg.startTime).getTime()) / 60000;

          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
            <Box key={i}>
              {/* Departure point */}
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 0.75 }}>
                <Box sx={{ width: 62, textAlign: "right", flexShrink: 0, whiteSpace: "nowrap" }}>
                  <LiveStopTime
                    scheduledTime={legStartTime}
                    tripId={!isWalk ? leg.tripId : undefined}
                    stopId={leg.from.stopId}
                  />
                </Box>
                <Box
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    border: `3px solid ${legColor}`,
                    bgcolor: i === 0 ? legColor : "#fff",
                    flexShrink: 0,
                  }}
                />
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    cursor: "pointer",
                    "&:hover": { opacity: 0.7 },
                  }}
                  onClick={() =>
                    handleStopClick(leg.from.name, leg.from.lat, leg.from.lng, leg.from.stopId)
                  }
                >
                  <Typography variant="body2" fontWeight={600}>
                    {leg.from.name}
                  </Typography>
                </Box>
              </Box>

              {/* Leg details */}
              <Box sx={{ display: "flex", gap: 1.5, py: 0.25 }}>
                <Box sx={{ width: 40, flexShrink: 0 }} />
                <Box
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    width: 12,
                    flexShrink: 0,
                  }}
                >
                  <Box
                    sx={{
                      width: 3,
                      flex: 1,
                      minHeight: 32,
                      bgcolor: legColor,
                      borderRadius: 1,
                      ...(isWalk
                        ? {
                            backgroundImage: `repeating-linear-gradient(to bottom, ${legColor} 0px, ${legColor} 4px, transparent 4px, transparent 8px)`,
                            bgcolor: "transparent",
                          }
                        : {}),
                    }}
                  />
                </Box>
                <Box sx={{ flex: 1, py: 0.5, minWidth: 0 }}>
                  {isWalk ? (
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                      <DirectionsWalkIcon sx={{ fontSize: 16, color: "text.secondary" }} />
                      <Typography variant="body2" color="text.secondary">
                        Walk — ~{Math.round(duration)} min
                      </Typography>
                    </Box>
                  ) : (
                    <Box>
                      <Box
                        sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}
                      >
                        {(() => {
                          const ModeIcon =
                            leg.mode === "rail"
                              ? TrainIcon
                              : leg.mode === "subway"
                                ? SubwayIcon
                                : leg.mode === "tram"
                                  ? TramIcon
                                  : leg.mode === "ferry"
                                    ? DirectionsBoatIcon
                                    : DirectionsBusIcon;
                          return <ModeIcon sx={{ fontSize: 16, color: "text.secondary" }} />;
                        })()}
                        <Box
                          onClick={
                            leg.tripId
                              ? () => setActiveLegDep(legToMergedDeparture(leg, provider))
                              : undefined
                          }
                          sx={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 0.5,
                            ...(leg.tripId
                              ? { cursor: "pointer", "&:hover": { opacity: 0.75 } }
                              : {}),
                          }}
                        >
                          {leg.route && (
                            <RouteBadge
                              shortName={leg.route.shortName}
                              color={leg.route.color}
                              mode={leg.mode}
                              size="small"
                            />
                          )}
                          <Typography variant="body2" sx={{ minWidth: 0, wordBreak: "break-word" }}>
                            {leg.route?.longName ?? leg.to.name}
                          </Typography>
                        </Box>
                        {leg.tripId && <TransitLiveBadge tripId={leg.tripId} />}
                      </Box>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ mt: 0.25, display: "block" }}
                      >
                        ~{Math.round(duration)} min
                      </Typography>
                      <TransitLegStops
                        tripId={leg.tripId}
                        stopCount={leg._intermediateStopCount}
                        fromStopId={leg.from.stopId}
                        toStopId={leg.to.stopId}
                      />
                      <LegAlerts routeId={leg.routeId} />
                      {leg.tripId && <LegRemarks tripId={leg.tripId} />}
                    </Box>
                  )}
                </Box>
              </Box>

              {/* Arrival point (only for last leg) */}
              {i === itinerary.legs.length - 1 && (
                <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, py: 0.75 }}>
                  <Box sx={{ width: 62, textAlign: "right", flexShrink: 0, whiteSpace: "nowrap" }}>
                    <LiveStopTime
                      scheduledTime={legEndTime}
                      tripId={!isWalk ? leg.tripId : undefined}
                      stopId={leg.to.stopId}
                    />
                  </Box>
                  <Box
                    sx={{
                      width: 12,
                      height: 12,
                      borderRadius: "50%",
                      border: `3px solid ${legColor}`,
                      bgcolor: legColor,
                      flexShrink: 0,
                    }}
                  />
                  <Box
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      cursor: "pointer",
                      "&:hover": { opacity: 0.7 },
                    }}
                    onClick={() =>
                      handleStopClick(leg.to.name, leg.to.lat, leg.to.lng, leg.to.stopId)
                    }
                  >
                    <Typography variant="body2" fontWeight={600}>
                      {leg.to.name}
                    </Typography>
                  </Box>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Data source attribution */}
      {provider &&
        (() => {
          const attr = resolveProvider(providers, provider);
          return (
            <Box sx={{ px: 2, py: 1.5, borderTop: "1px solid", borderColor: "divider" }}>
              <Typography variant="caption" color="text.disabled">
                Data:{" "}
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
    </Box>
  );
}

// Main component

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
    transitItineraries,
    activeItineraryIndex,
    transitDepartureTime,
    transitArrivalTime,
    close,
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
  const { setSidePanelCollapsed } = usePlaceStore();
  const { data: providers } = useProviders(); // for transit plan attribution
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
  const { data: wsSuggestions } = useAutocomplete(debouncedActiveQuery);
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
          overflowX: "hidden",
          overflowY: "auto",
          borderRadius: { xs: "16px 16px 0 0", sm: 0 },
          boxShadow: { xs: 6, sm: "4px 0 12px rgba(0,0,0,0.15)" },
          zIndex: 9,
          transform: { sm: collapsed ? "translateX(-100%)" : "translateX(0)" },
          transition: { sm: "transform 0.25s ease" },
        }}
      >
        {transitDetailsIndex !== null && transitItineraries[transitDetailsIndex] ? (
          <TransitDetailsView
            itinerary={transitItineraries[transitDetailsIndex]}
            originLabel={originLabel}
            destinationLabel={destinationLabel}
            provider={transitPlanData?.provider}
            onBack={() => setTransitDetailsIndex(null)}
          />
        ) : detailsRoute ? (
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
                      label={label}
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

              {/* ── Leave now / Depart at / Arrive by + Options ── */}
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
                      ? "Leave now"
                      : transitTimeMode === "depart"
                        ? `Depart ${transitDepartureTime instanceof Date ? transitDepartureTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}`
                        : `Arrive by ${transitArrivalTime instanceof Date ? transitArrivalTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}`}
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
                    Options
                  </Typography>
                )}
              </Box>

              {/* ── Transit time picker dropdown ── */}
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
                          {m === "now" ? "Leave now" : m === "depart" ? "Depart at" : "Arrive by"}
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

              {showOptions && !isTransitMode && <OptionsPanel />}

              <Divider />

              {/* ── Route results ── */}
              {!origin || !destination ? (
                <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
                  <Typography variant="body2" color="text.secondary">
                    Enter a starting point and destination to get directions
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
                      Could not get transit directions. Please try again.
                    </Typography>
                  </Box>
                ) : transitItineraries.length === 0 ? (
                  <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
                    <Typography variant="body2" color="text.secondary">
                      No transit routes found for this area.
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
                          More options
                        </Typography>
                      </Box>
                    )}
                    {transitPlanData?.provider &&
                      (() => {
                        const attr = resolveProvider(providers, transitPlanData.provider ?? "");
                        return (
                          <Box
                            sx={{ px: 2, py: 1.5, borderTop: "1px solid", borderColor: "divider" }}
                          >
                            <Typography variant="caption" color="text.disabled">
                              Data:{" "}
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

      <SidebarCollapseToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
    </>
  );
}
