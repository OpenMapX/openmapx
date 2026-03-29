"use client";

import AirlineSeatReclineNormalIcon from "@mui/icons-material/AirlineSeatReclineNormal";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ConfirmationNumberOutlinedIcon from "@mui/icons-material/ConfirmationNumberOutlined";
import DirectionsBoatIcon from "@mui/icons-material/DirectionsBoat";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import SubwayIcon from "@mui/icons-material/Subway";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { MergedDeparture, Place, TripItinerary, TripLeg } from "@openmapx/core";
import {
  formatDuration,
  geocodeStopAsPlace,
  PANEL,
  resolveProvider,
  usePlaceStore,
  useProviders,
  useSidebarStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  LegBadge,
  LegRemarks,
  LiveStopTime,
  TransitLiveBadge,
} from "@/components/panels/directions/TransitRouteView";
import { LegAlerts } from "@/components/panels/transit/LegAlerts";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { TransitLegStops } from "@/components/panels/transit/TransitLegStops";
import { TripDetailView } from "@/components/panels/transit/TripDetailView";
import { extractFareSummary, formatFare } from "@/lib/fareUtils";
import { useMap } from "@/lib/MapContext";
import { TEAL } from "@/lib/theme";

import { OCCUPANCY_COLOR, OCCUPANCY_KEY } from "@/lib/transitOccupancy";

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

export function TransitDetailsView({
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
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const tt = useTranslations("transit");
  const locale = useLocale();
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
        useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
      },
    );
  }
  const startTime = new Date(itinerary.startTime).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const endTime = new Date(itinerary.endTime).toLocaleTimeString(locale, {
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
            {t("from")}{" "}
            <Box component="span" fontWeight={600} color="text.primary">
              {originLabel || t("origin")}
            </Box>
          </Typography>
          <br />
          <Typography variant="caption" color="text.secondary">
            {t("to")}{" "}
            <Box component="span" fontWeight={600} color="text.primary">
              {destinationLabel || t("destination")}
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
          const legStartTime = new Date(leg.startTime).toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
          });
          const legEndTime = new Date(leg.endTime).toLocaleTimeString(locale, {
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
                    tripId={
                      !isWalk
                        ? leg.tripId
                        : i > 0 && itinerary.legs[i - 1].tripId
                          ? itinerary.legs[i - 1].tripId
                          : undefined
                    }
                    stopId={leg.from.stopId}
                  />
                </Box>
                <Box
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    border: `3px solid ${legColor}`,
                    bgcolor: i === 0 ? legColor : "background.paper",
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
                        {t("walkDuration", { duration: formatDuration(Math.round(duration) * 60) })}
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
                        {leg.occupancy && (
                          <Tooltip title={tt(OCCUPANCY_KEY[leg.occupancy])} placement="top" arrow>
                            <AirlineSeatReclineNormalIcon
                              sx={{ fontSize: 14, color: OCCUPANCY_COLOR[leg.occupancy] }}
                            />
                          </Tooltip>
                        )}
                      </Box>
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ mt: 0.25, display: "block" }}
                      >
                        {t("transitDuration", {
                          duration: formatDuration(Math.round(duration) * 60),
                        })}
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

      {/* Fare */}
      {(() => {
        const fareSummary = extractFareSummary(itinerary.fare);
        if (!fareSummary) return null;
        const mediaNames = [
          ...new Set(
            fareSummary.products.map((p) => p.media?.name).filter((n): n is string => Boolean(n)),
          ),
        ];
        return (
          <>
            <Divider />
            <Box sx={{ px: 2, py: 1.5 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <ConfirmationNumberOutlinedIcon sx={{ fontSize: 18, color: "text.secondary" }} />
                <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
                  {t("fare")}
                </Typography>
                <Typography variant="body2" fontWeight={600}>
                  {t("fareApprox", {
                    amount: formatFare(fareSummary.amount, fareSummary.currency, locale),
                  })}
                </Typography>
              </Box>
              {fareSummary.byCategory.length > 1 && (
                <Box sx={{ mt: 0.75, display: "flex", flexDirection: "column", gap: 0.25 }}>
                  {fareSummary.byCategory.map((cat) => (
                    <Box key={cat.name} sx={{ display: "flex", justifyContent: "space-between" }}>
                      <Typography variant="caption" color="text.secondary">
                        {cat.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {formatFare(cat.amount, fareSummary.currency, locale)}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              )}
              {mediaNames.length > 0 && (
                <Typography
                  variant="caption"
                  color="text.disabled"
                  sx={{ mt: 0.5, display: "block" }}
                >
                  {mediaNames.join(", ")}
                </Typography>
              )}
            </Box>
          </>
        );
      })()}

      {/* Data source attribution */}
      {provider &&
        (() => {
          const attr = resolveProvider(providers, provider);
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
    </Box>
  );
}
