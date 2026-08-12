"use client";

import type { SvgIconComponent } from "@mui/icons-material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ConfirmationNumberOutlinedIcon from "@mui/icons-material/ConfirmationNumberOutlined";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsBoatIcon from "@mui/icons-material/DirectionsBoat";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import SubwayIcon from "@mui/icons-material/Subway";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  formatDistance,
  formatDuration,
  geocodeStopAsPlace,
  PANEL,
  safeHref,
  tzOffsetLabel,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import {
  changedFromPlatform,
  composeWalkInstruction,
  nextTransferFor,
  walkStepInfo,
} from "@openmapx/core/navigation";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type {
  MergedDeparture,
  TransportMode,
  TripItinerary,
  TripLeg,
} from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  LegBadge,
  LegRemarks,
  LiveStopTime,
  TransitEmissionsBadge,
  TransitLiveBadge,
} from "@/components/panels/directions/TransitRouteView";
import { TransitTransferSummary } from "@/components/panels/directions/TransitTransferSummary";
import { LegAlerts } from "@/components/panels/transit/LegAlerts";
import { OccupancyIndicator } from "@/components/panels/transit/OccupancyIndicator";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { TransitLegStops } from "@/components/panels/transit/TransitLegStops";
import { TripDetailView } from "@/components/panels/transit/TripDetailView";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { extractFareSummary, formatFare } from "@/lib/fareUtils";
import { useMap } from "@/lib/MapContext";
import { BRAND } from "@/lib/theme";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";

/**
 * Per-mode rendering for non-transit street legs (walk + intermodal bike/car
 * access): line colour, glyph, and the i18n duration key. One table instead of
 * three parallel ternaries so a new street mode is added in a single place.
 */
const STREET_LEG: Partial<
  Record<TransportMode, { color: string; Icon: SvgIconComponent; durationKey: string }>
> = {
  walking: { color: "#757575", Icon: DirectionsWalkIcon, durationKey: "walkDuration" },
  cycling: { color: "#34A853", Icon: DirectionsBikeIcon, durationKey: "bikeDuration" },
  driving: { color: "#5F6368", Icon: DirectionsCarIcon, durationKey: "driveDuration" },
};

/**
 * A leg's per-leg attribution set is redundant when it carries no entries or
 * exactly mirrors the trip-level union; in either case we suppress the inline
 * strip so the panel-level credits remain the single source of truth.
 */
function isPerLegRedundant(
  legAttrs: Attribution[] | undefined,
  tripAttrs: Attribution[] | undefined,
): boolean {
  if (!legAttrs || legAttrs.length === 0) return true;
  const trip = tripAttrs ?? [];
  if (legAttrs.length !== trip.length) return false;
  const legIds = new Set(legAttrs.map((a) => a.sourceId));
  return trip.every((a) => legIds.has(a.sourceId));
}

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

function LegStatusDetails({ leg }: { leg: TripLeg }) {
  const t = useTranslations("directions");
  const tNav = useTranslations("navigation");
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const statuses: string[] = [];
  if (leg.cancelled) statuses.push(t("journeyCancelled"));
  if (leg.realtime === true) statuses.push(t("realtimeSupported"));
  if (leg.bikesAllowed === true) statuses.push(t("bikesSupported"));
  if (leg.bikesAllowed === false) statuses.push(t("bikesNotSupported"));
  if (leg.wheelchairAccessible === true) statuses.push(t("wheelchairSupported"));
  if (leg.wheelchairAccessible === false) statuses.push(t("wheelchairNotSupported"));
  if (leg.rental?.returnConstraint === "ANY_STATION") statuses.push(t("returnAnyStation"));
  if (leg.rental?.returnConstraint === "ROUNDTRIP_STATION") {
    statuses.push(t("returnSameStation"));
  }
  if (leg.ascentMeters) statuses.push(t("ascent", { meters: Math.round(leg.ascentMeters) }));

  return (
    <>
      {statuses.length > 0 && (
        <Typography
          variant="caption"
          sx={{ color: leg.cancelled ? "error.main" : "text.secondary", display: "block", mt: 0.5 }}
        >
          {statuses.join(" · ")}
        </Typography>
      )}
      {leg.steps && leg.steps.length > 0 && (
        <Box sx={{ mt: 0.5 }}>
          {/* Collapsed by default: show the total walking distance, expand for the
              turn-by-turn steps — mirrors the intermediate-stops toggle on rides. */}
          <Box
            onClick={() => setStepsExpanded((e) => !e)}
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.25,
              cursor: "pointer",
              color: "text.secondary",
              userSelect: "none",
              "&:hover": { color: "text.primary" },
            }}
          >
            {stepsExpanded ? (
              <ExpandLessIcon sx={{ fontSize: 14 }} />
            ) : (
              <ExpandMoreIcon sx={{ fontSize: 14 }} />
            )}
            <Typography variant="caption">
              {t("walkDistance", {
                distance: formatDistance(
                  leg.steps.reduce((sum, step) => sum + (step.distanceMeters ?? 0), 0),
                ),
              })}
            </Typography>
          </Box>
          <Collapse in={stepsExpanded}>
            <Box component="ol" sx={{ pl: 2.5, my: 0.75 }} aria-label={t("routeInstructions")}>
              {leg.steps.map((step, stepIndex) => (
                <Typography
                  component="li"
                  variant="caption"
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id and identical steps repeat within a leg; the index disambiguates them
                  key={`${stepIndex}-${step.instruction}-${step.fromLevel}-${step.toLevel}-${step.distanceMeters}-${step.streetName ?? ""}`}
                >
                  {composeWalkInstruction(walkStepInfo(step), tNav)} ·{" "}
                  {formatDistance(step.distanceMeters)}
                  {step.accessRestriction ? ` · ${t("accessRestricted")}` : ""}
                </Typography>
              ))}
            </Box>
          </Collapse>
        </Box>
      )}
    </>
  );
}

export function TransitDetailsView({
  itinerary,
  isLowestCo2 = false,
  originLabel,
  destinationLabel,
  provider,
  attributions,
  originTimeZone = null,
  destinationTimeZone = null,
  onBack,
}: {
  itinerary: TripItinerary;
  isLowestCo2?: boolean;
  originLabel: string;
  destinationLabel: string;
  /** Provider id (e.g. "motis", "otp") — kept for legToMergedDeparture context. */
  provider?: string;
  /** Trip-plan envelope attributions, rendered at the bottom of the details. */
  attributions?: Attribution[];
  /**
   * Set only when the origin's zone differs from the viewer's; renders the
   * departure in that zone instead of the viewer's, keeping the pair
   * internally consistent. No offset chip — see the identical prop on
   * `TransitItineraryCard`.
   */
  originTimeZone?: string | null;
  /** Set only when the trip crosses a time-zone boundary; renders the arrival in that zone with an offset chip. */
  destinationTimeZone?: string | null;
  onBack: () => void;
}) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const tNav = useTranslations("navigation");
  const locale = useLocale();
  const fmt = useDateTimeFormat();
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
  // Resolve each offset label before formatting the time it gates: unlike
  // these helpers, `fmt.time({ timeZone })` throws (rather than degrading)
  // for a zone id the platform doesn't recognise, so the label doubles as
  // the validity check that keeps the call below from taking the panel down.
  const originOffsetLabel = originTimeZone
    ? tzOffsetLabel(new Date(itinerary.startTime), originTimeZone)
    : null;
  const startTime = fmt.time(
    itinerary.startTime,
    originOffsetLabel ? { timeZone: originTimeZone as string } : undefined,
  );
  const destinationOffsetLabel = destinationTimeZone
    ? tzOffsetLabel(new Date(itinerary.endTime), destinationTimeZone)
    : null;
  const endTime = fmt.time(
    itinerary.endTime,
    destinationOffsetLabel ? { timeZone: destinationTimeZone as string } : undefined,
  );
  const summaryBits: string[] = [];
  if (itinerary.transfers > 0) summaryBits.push(t("transfers", { count: itinerary.transfers }));
  if (itinerary.walkDistance > 0) {
    summaryBits.push(t("walkDistance", { distance: formatDistance(itinerary.walkDistance) }));
  }

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
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {t("from")}{" "}
            <Box
              component="span"
              sx={{
                fontWeight: 600,
                color: "text.primary",
              }}
            >
              {originLabel || t("origin")}
            </Box>
          </Typography>
          <br />
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {t("to")}{" "}
            <Box
              component="span"
              sx={{
                fontWeight: 600,
                color: "text.primary",
              }}
            >
              {destinationLabel || t("destination")}
            </Box>
          </Typography>
        </Box>
      </Box>
      <Divider />
      {/* Summary */}
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography
          variant="h6"
          component="span"
          sx={{
            fontWeight: 600,
          }}
        >
          {startTime} – {endTime}{" "}
        </Typography>
        {destinationOffsetLabel && (
          <Typography component="span" sx={{ fontSize: 11, color: "text.secondary", ml: 0.5 }}>
            {destinationOffsetLabel}
          </Typography>
        )}
        <Typography
          variant="body1"
          component="span"
          sx={{
            color: "text.secondary",
          }}
        >
          ({formatDuration(itinerary.duration)})
        </Typography>
        {/* This view is an early return from the itinerary list, so the
            explanatory line the list renders below its cards never reaches
            the screen here — without it, the chip above is unexplained. */}
        {destinationTimeZone && (
          <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5, display: "block" }}>
            {t("arrivalInDestinationTime")}
          </Typography>
        )}
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
        {summaryBits.length > 0 && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              mt: 0.75,
              display: "block",
            }}
          >
            {summaryBits.join(" · ")}
          </Typography>
        )}
        {itinerary.invalidRequirements && itinerary.invalidRequirements.length > 0 && (
          <Typography role="alert" variant="body2" sx={{ color: "error.main", mt: 1 }}>
            {t("requirementsContradicted", {
              requirements: itinerary.invalidRequirements.join(", "),
            })}
          </Typography>
        )}
        {itinerary.co2Grams !== undefined && (
          <Box sx={{ mt: summaryBits.length > 0 ? 0.75 : 1 }}>
            <TransitEmissionsBadge co2Grams={itinerary.co2Grams} isLowest={isLowestCo2} />
          </Box>
        )}
      </Box>
      <Divider />
      {/* Timeline */}
      <Box sx={{ pl: 1, pr: 2, py: 1 }}>
        {itinerary.legs.map((leg, i) => {
          const legStartTime = fmt.time(leg.startTime);
          const legEndTime = fmt.time(leg.endTime);
          const isWalk = leg.mode === "walking";
          // Non-transit street legs (walk + intermodal bike/car access) share the
          // compact dashed-line rendering; `street` is set only for those.
          const street = STREET_LEG[leg.mode];
          const legColor = street
            ? street.color
            : leg.route?.color
              ? `#${leg.route.color.replace("#", "")}`
              : BRAND;
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
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {leg.from.name}
                    </Typography>
                    {!isWalk && leg.from.platformCode && (
                      <PlatformBadge
                        code={leg.from.platformCode}
                        changed={!!changedFromPlatform(leg.from)}
                      />
                    )}
                    {!isWalk && leg.from.level != null && leg.from.level !== 0 && (
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {tNav("levelShort", { level: leg.from.level })}
                      </Typography>
                    )}
                  </Box>
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
                      ...(street
                        ? {
                            backgroundImage: `repeating-linear-gradient(to bottom, ${legColor} 0px, ${legColor} 4px, transparent 4px, transparent 8px)`,
                            bgcolor: "transparent",
                          }
                        : {}),
                    }}
                  />
                </Box>
                <Box sx={{ flex: 1, py: 0.5, minWidth: 0 }}>
                  {street ? (
                    <Box>
                      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                        <street.Icon sx={{ fontSize: 16, color: "text.secondary" }} />
                        <Typography variant="body2" sx={{ color: "text.secondary" }}>
                          {t(street.durationKey, {
                            duration: formatDuration(Math.round(duration) * 60),
                          })}
                        </Typography>
                      </Box>
                      {leg.rental && (
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.75,
                            mt: 0.25,
                            flexWrap: "wrap",
                          }}
                        >
                          {leg.rental.color && (
                            <Box
                              sx={{
                                width: 10,
                                height: 10,
                                borderRadius: "2px",
                                bgcolor: `#${leg.rental.color}`,
                                flexShrink: 0,
                              }}
                            />
                          )}
                          <Typography variant="caption" sx={{ color: "text.secondary" }}>
                            {leg.rental.providerName ?? leg.rental.systemName ?? t("rentalVehicle")}
                          </Typography>
                          {leg.rental.bookingUrl && (
                            <Link
                              href={safeHref(leg.rental.bookingUrl)}
                              target="_blank"
                              rel="noopener noreferrer"
                              variant="caption"
                              sx={{ color: BRAND }}
                            >
                              {t("book")}
                            </Link>
                          )}
                        </Box>
                      )}
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
                              textColor={leg.route.textColor}
                              mode={leg.mode}
                              size="small"
                            />
                          )}
                          <Typography variant="body2" sx={{ minWidth: 0, wordBreak: "break-word" }}>
                            {leg.route?.longName ?? leg.to.name}
                          </Typography>
                        </Box>
                        {leg.tripId && <TransitLiveBadge tripId={leg.tripId} />}
                        {leg.occupancy && <OccupancyIndicator level={leg.occupancy} size={14} />}
                      </Box>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          mt: 0.25,
                          display: "block",
                        }}
                      >
                        {t("transitDuration", {
                          duration: formatDuration(Math.round(duration) * 60),
                        })}
                      </Typography>
                      {(() => {
                        const headsign =
                          leg.headsign && leg.headsign !== leg.to.name ? leg.headsign : undefined;
                        const identity = [
                          [leg.category, leg.tripShortName].filter(Boolean).join(" ").trim(),
                          leg.operatorName,
                        ]
                          .filter(Boolean)
                          .join(" · ");
                        if (!headsign && !identity) return null;
                        return (
                          <Typography
                            variant="caption"
                            noWrap
                            sx={{ color: "text.secondary", display: "block" }}
                          >
                            {[headsign ? tNav("towards", { headsign }) : null, identity || null]
                              .filter(Boolean)
                              .join(" · ")}
                          </Typography>
                        );
                      })()}
                      {leg.flex && (
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.75,
                            mt: 0.25,
                            flexWrap: "wrap",
                          }}
                        >
                          <Typography
                            variant="caption"
                            sx={{ color: "warning.main", fontWeight: 600 }}
                          >
                            {t("onDemandBookAhead")}
                          </Typography>
                          {leg.flex.bookingUrl && (
                            <Link
                              href={safeHref(leg.flex.bookingUrl)}
                              target="_blank"
                              rel="noopener noreferrer"
                              variant="caption"
                              sx={{ color: BRAND }}
                            >
                              {t("book")}
                            </Link>
                          )}
                        </Box>
                      )}
                      {leg.alternatives && leg.alternatives.length > 0 && (
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.5,
                            mt: 0.25,
                            flexWrap: "wrap",
                          }}
                        >
                          <Typography variant="caption" sx={{ color: "text.secondary" }}>
                            {t("alsoDeparts")}
                          </Typography>
                          {leg.alternatives.map((alt) => (
                            <Box
                              key={alt.startTime}
                              component="span"
                              sx={{
                                px: 0.75,
                                py: 0.1,
                                borderRadius: 1,
                                bgcolor: "action.hover",
                                color: "text.secondary",
                                fontSize: 12,
                              }}
                            >
                              {fmt.time(alt.startTime)}
                            </Box>
                          ))}
                        </Box>
                      )}
                      <TransitLegStops
                        tripId={leg.tripId}
                        stopCount={leg._intermediateStopCount}
                        fromStopId={leg.from.stopId}
                        toStopId={leg.to.stopId}
                      />
                      <LegAlerts routeId={leg.routeId} legAlerts={leg.alerts} />
                      {leg.tripId && <LegRemarks tripId={leg.tripId} />}
                      {!isPerLegRedundant(leg.attributions, attributions) && (
                        <Box sx={{ mt: 0.5 }}>
                          <AttributionStrip attributions={leg.attributions} variant="inline" />
                        </Box>
                      )}
                    </Box>
                  )}
                  <LegStatusDetails leg={leg} />
                </Box>
              </Box>
              {/* Interchange summary after a ride that changes onto another. When a
                  walk leg follows, its own row shows the walk, so suppress it here. */}
              {leg.route &&
                (() => {
                  const transfer = nextTransferFor(itinerary.legs, i);
                  if (!transfer) return null;
                  const walk = itinerary.legs[i + 1]?.mode === "walking" ? 0 : transfer.walkSeconds;
                  return (
                    <TransitTransferSummary
                      fromLeg={leg}
                      nextLeg={transfer.nextLeg}
                      walkSeconds={walk}
                    />
                  );
                })()}
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
                    <Box
                      sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {leg.to.name}
                      </Typography>
                      {!isWalk && leg.to.platformCode && (
                        <PlatformBadge
                          code={leg.to.platformCode}
                          changed={!!changedFromPlatform(leg.to)}
                        />
                      )}
                      {!isWalk && leg.to.level != null && leg.to.level !== 0 && (
                        <Typography variant="caption" sx={{ color: "text.secondary" }}>
                          {tNav("levelShort", { level: leg.to.level })}
                        </Typography>
                      )}
                    </Box>
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
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                    flex: 1,
                  }}
                >
                  {t("fare")}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                  }}
                >
                  {t("fareApprox", {
                    amount: formatFare(fareSummary.amount, fareSummary.currency, locale),
                  })}
                </Typography>
              </Box>
              {fareSummary.byCategory.length > 1 && (
                <Box sx={{ mt: 0.75, display: "flex", flexDirection: "column", gap: 0.25 }}>
                  {fareSummary.byCategory.map((cat) => (
                    <Box key={cat.name} sx={{ display: "flex", justifyContent: "space-between" }}>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {cat.name}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {formatFare(cat.amount, fareSummary.currency, locale)}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              )}
              {mediaNames.length > 0 && (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.disabled",
                    mt: 0.5,
                    display: "block",
                  }}
                >
                  {mediaNames.join(", ")}
                </Typography>
              )}
            </Box>
          </>
        );
      })()}
      {/* Data source attribution */}
      <AttributionStrip
        attributions={attributions ?? []}
        variant="panel-header"
        label={tc("dataSources")}
      />
    </Box>
  );
}
