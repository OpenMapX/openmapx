"use client";

import type { SvgIconComponent } from "@mui/icons-material";
import CommuteIcon from "@mui/icons-material/Commute";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsBoatIcon from "@mui/icons-material/DirectionsBoat";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import SubwayIcon from "@mui/icons-material/Subway";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Collapse from "@mui/material/Collapse";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import {
  formatDuration,
  formatMeasurementDistance,
  routeColor,
  safeHref,
  tzOffsetLabel,
  useSettingsStore,
} from "@openmapx/core";
import {
  changedFromPlatform,
  composeWalkInstruction,
  nextTransferFor,
  walkStepInfo,
} from "@openmapx/core/navigation";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  captureResultContributors,
  contributorKey,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { TransportMode, TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import { composeTransitAlternative } from "@openmapx/mobility-core/transit-alternative";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import {
  LegRemarks,
  LiveStopTime,
  TransitLiveBadge,
} from "@/components/panels/directions/TransitRouteView";
import { TransitTransferSummary } from "@/components/panels/directions/TransitTransferSummary";
import { tripPlaceName } from "@/components/panels/directions/transitSummary";
import { LegAlerts } from "@/components/panels/transit/LegAlerts";
import { OccupancyIndicator } from "@/components/panels/transit/OccupancyIndicator";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { TransitLegStops } from "@/components/panels/transit/TransitLegStops";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { ClickableRow } from "@/components/ui/ClickableRow";
import { RailDot, type RailSegment, TimelineRow } from "@/components/ui/TimelineRail";
import { BRAND } from "@/integration-api/runtime/theme";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { legTransitTime } from "@/lib/transitTime";
import { getWheelchairStatus } from "./transitAccessibility";

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
  const legIds = new Set(legAttrs.map(contributorKey));
  return trip.every((a) => legIds.has(contributorKey(a)));
}

function LegStatusDetails({ leg, itinerary }: { leg: TripLeg; itinerary: TripItinerary }) {
  const t = useTranslations("directions");
  const statuses: string[] = [];
  if (leg.cancelled) statuses.push(t("journeyCancelled"));
  if (leg.realtime === true) statuses.push(t("realtimeSupported"));
  if (leg.bikesAllowed === true) statuses.push(t("bikesSupported"));
  if (leg.bikesAllowed === false) statuses.push(t("bikesNotSupported"));
  const wheelchairStatus = getWheelchairStatus(leg, itinerary);
  if (wheelchairStatus === "accessible") statuses.push(t("wheelchairSupported"));
  if (wheelchairStatus === "inaccessible") statuses.push(t("wheelchairNotSupported"));
  if (wheelchairStatus === "unconfirmed") statuses.push(t("wheelchairUnconfirmed"));
  if (leg.rental?.returnConstraint === "ANY_STATION") statuses.push(t("returnAnyStation"));
  if (leg.rental?.returnConstraint === "ROUNDTRIP_STATION") {
    statuses.push(t("returnSameStation"));
  }
  if (leg.ascentMeters) statuses.push(t("ascent", { meters: Math.round(leg.ascentMeters) }));
  if (statuses.length === 0) return null;
  return (
    <Typography
      variant="caption"
      sx={{ color: leg.cancelled ? "error.main" : "text.secondary", display: "block", mt: 0.5 }}
    >
      {statuses.join(" · ")}
    </Typography>
  );
}

/**
 * A walk (or ride by bike or car) as one line, "Walk 2 min (106 m)", that
 * opens its turn-by-turn steps when it has them.
 */
function StreetLegSummary({ leg, label }: { leg: TripLeg; label: string }) {
  const t = useTranslations("directions");
  const tNav = useTranslations("navigation");
  const units = useSettingsStore((s) => s.units);
  const [expanded, setExpanded] = useState(false);
  const steps = leg.steps ?? [];
  const meters =
    leg.distanceMeters ?? steps.reduce((sum, step) => sum + (step.distanceMeters ?? 0), 0);
  const text = (
    <Typography variant="body2" sx={{ color: "text.secondary" }}>
      {meters > 0 ? `${label} (${formatMeasurementDistance(meters, units)})` : label}
    </Typography>
  );
  if (steps.length === 0) return text;
  return (
    <>
      <ClickableRow
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        sx={{
          width: "auto",
          display: "inline-flex",
          alignItems: "center",
          gap: 0.25,
          userSelect: "none",
          "&:hover": { opacity: 0.75 },
        }}
      >
        {text}
        {expanded ? (
          <ExpandLessIcon sx={{ fontSize: 18, color: "text.secondary" }} />
        ) : (
          <ExpandMoreIcon sx={{ fontSize: 18, color: "text.secondary" }} />
        )}
      </ClickableRow>
      <Collapse in={expanded}>
        <Box component="ol" sx={{ pl: 2.5, my: 0.75 }} aria-label={t("routeInstructions")}>
          {steps.map((step, stepIndex) => (
            <Typography
              component="li"
              variant="caption"
              // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id and identical steps repeat within a leg; the index disambiguates them
              key={`${stepIndex}-${step.instruction}-${step.fromLevel}-${step.toLevel}-${step.distanceMeters}-${step.streetName ?? ""}`}
            >
              {composeWalkInstruction(walkStepInfo(step), tNav)} ·{" "}
              {formatMeasurementDistance(step.distanceMeters, units)}
              {step.accessRestriction ? ` · ${t("accessRestricted")}` : ""}
            </Typography>
          ))}
        </Box>
      </Collapse>
    </>
  );
}

/** Everyone whose data the trip shows, for its credits. */
export function itineraryContributors(
  itinerary: TripItinerary,
  attributions: Attribution[] = [],
): Attribution[] {
  return itinerary.contributors !== undefined
    ? snapshotContributors(itinerary.contributors)
    : snapshotContributors(
        captureResultContributors(itinerary, attributions),
        ...itinerary.legs.map((leg) => leg.contributors ?? leg.attributions ?? []),
        itinerary.fare?.contributors ?? [],
      );
}

/**
 * A transit trip as a vertical timeline, read like a line map: a rail on the
 * left (a thick bar in each ride's colour, dots where the rider walks), what
 * happens at each point and along each leg in the middle, and the times on the
 * right. Shared by the route details and the guidance sheet, so the trip reads
 * the same before and during the journey.
 */
export function TransitLegTimeline({
  itinerary,
  originLabel,
  destinationLabel,
  selectedAttributions,
  originTimeZone = null,
  destinationTimeZone = null,
  onStopClick,
  onOpenLeg,
  onSelectItinerary,
  live = true,
  fromLegIndex = 0,
  renderStops,
  legPlatform = plannedPlatform,
}: {
  itinerary: TripItinerary;
  originLabel: string;
  destinationLabel: string;
  /** The trip's credits, so a leg only repeats its own when they differ. */
  selectedAttributions: Attribution[];
  originTimeZone?: string | null;
  destinationTimeZone?: string | null;
  /** Opens a stop; without it the stops are plain text. */
  onStopClick?: (place: TripLeg["from"]) => void;
  /** Opens a ride's departures; without it the line name is plain text. */
  onOpenLeg?: (leg: TripLeg) => void;
  onSelectItinerary?: (parent: TripItinerary, candidate: TripItinerary) => void;
  /**
   * Whether the timeline may fetch live times, stops and alerts itself. Off
   * where another owner already follows the trip's live data.
   */
  live?: boolean;
  /** Legs before this one are left out (the guidance sheet hides those passed). */
  fromLegIndex?: number;
  /**
   * Replaces a ride's own stop list with timeline rows (see {@link TimelineRow}),
   * e.g. with live progress along it.
   */
  renderStops?: (leg: TripLeg, index: number) => ReactNode | undefined;
  /** Where a ride boards or alights; by default the planned platform. */
  legPlatform?: (leg: TripLeg, index: number, event: "departure" | "arrival") => LegPlatformInfo;
}) {
  const t = useTranslations("directions");
  const locale = useLocale();
  const fmt = useDateTimeFormat();
  const liveTrip = (tripId: string | undefined) => (live ? tripId : undefined);
  const legs = itinerary.legs;

  return (
    <Box sx={{ pr: 2, py: 0.5 }}>
      {legs.map((leg, i) => {
        if (i < fromLegIndex) return null;
        const isWalk = leg.mode === "walking";
        // Non-transit street legs (walk + intermodal bike/car access) share the
        // dotted rail; `street` is set only for those.
        const street = STREET_LEG[leg.mode];
        const segment = railSegment(leg);
        const previous = i > fromLegIndex ? legs[i - 1] : undefined;
        const duration =
          (new Date(leg.endTime).getTime() - new Date(leg.startTime).getTime()) / 60000;
        const stops = street ? undefined : renderStops?.(leg, i);
        const transfer = leg.route ? nextTransferFor(legs, i) : null;

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
          <Box key={i}>
            {/* Departure point */}
            <TimelineRow
              above={railSegment(previous)}
              below={segment}
              divider={i > fromLegIndex}
              node={pointNode(previous, leg, i === 0 && !leg.from.stopId)}
              time={
                <LiveStopTime
                  time={legTransitTime(leg)}
                  event={isWalk && i > 0 ? "arrival" : "departure"}
                  tripId={liveTrip(!isWalk ? leg.tripId : i > 0 ? legs[i - 1].tripId : undefined)}
                  stopId={leg.from.stopId}
                  emphasis
                />
              }
            >
              <StopRow onClick={onStopClick && (() => onStopClick(leg.from))}>
                <PointName
                  name={i === 0 ? tripPlaceName(leg.from, originLabel) : leg.from.name}
                  platform={!isWalk ? legPlatform(leg, i, "departure") : undefined}
                  level={!isWalk ? leg.from.level : undefined}
                />
              </StopRow>
            </TimelineRow>
            {/* How the leg is travelled */}
            <TimelineRow
              through={segment}
              divider={!!street}
              node={street ? <StreetNode Icon={street.Icon} /> : undefined}
            >
              {street ? (
                <Box>
                  <StreetLegSummary
                    leg={leg}
                    label={t(street.durationKey, {
                      duration: formatDuration(Math.round(duration) * 60, locale),
                    })}
                  />
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
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
                    <LegLineLabel
                      onOpen={leg.tripId && onOpenLeg ? () => onOpenLeg(leg) : undefined}
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
                      {/* Where the line is heading, as on the vehicle's sign. */}
                      <Typography
                        variant="body2"
                        sx={{ minWidth: 0, wordBreak: "break-word", fontWeight: 500 }}
                      >
                        {leg.headsign || leg.route?.longName || leg.to.name}
                      </Typography>
                    </LegLineLabel>
                    {live && leg.tripId && <TransitLiveBadge tripId={leg.tripId} />}
                    {leg.occupancy && <OccupancyIndicator level={leg.occupancy} size={14} />}
                  </Box>
                  {/* How long the ride takes, and which train it is. */}
                  <Typography
                    variant="caption"
                    sx={{ color: "text.secondary", mt: 0.25, display: "block" }}
                  >
                    {[
                      t("transitDuration", {
                        duration: formatDuration(Math.round(duration) * 60, locale),
                      }),
                      [leg.category, leg.tripShortName].filter(Boolean).join(" ").trim(),
                      leg.operatorName,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Typography>
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
                      <Typography variant="caption" sx={{ color: "warning.main", fontWeight: 600 }}>
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
                        {t("transitAlternatives")}
                      </Typography>
                      {leg.alternatives.map((alt, alternativeIndex) => {
                        const candidate = composeTransitAlternative(itinerary, i, alternativeIndex);
                        const label = `${alt.routeShortName ? `${alt.routeShortName} · ` : ""}${fmt.time(alt.startTime, originTimeZone && tzOffsetLabel(new Date(alt.startTime), originTimeZone) ? { timeZone: originTimeZone } : undefined)} – ${fmt.time(alt.endTime, destinationTimeZone && tzOffsetLabel(new Date(alt.endTime), destinationTimeZone) ? { timeZone: destinationTimeZone } : undefined)}`;
                        return candidate && onSelectItinerary ? (
                          <Button
                            key={`${alt.tripId}:${alt.routeShortName}:${alt.startTime}:${alt.endTime}`}
                            size="small"
                            variant="outlined"
                            onClick={() => onSelectItinerary(itinerary, candidate)}
                          >
                            {label}
                          </Button>
                        ) : (
                          <Typography
                            key={`${alt.tripId}:${alt.routeShortName}:${alt.startTime}:${alt.endTime}`}
                            variant="caption"
                            sx={{ color: "text.secondary" }}
                          >
                            {label}
                          </Typography>
                        );
                      })}
                    </Box>
                  )}
                  {stops === undefined && (
                    <TransitLegStops
                      tripId={liveTrip(leg.tripId)}
                      stopCount={leg._intermediateStopCount}
                      fromStopId={leg.from.stopId}
                      toStopId={leg.to.stopId}
                    />
                  )}
                  <LegAlerts routeId={live ? leg.routeId : undefined} legAlerts={leg.alerts} />
                  {live && leg.tripId && <LegRemarks tripId={leg.tripId} />}
                  {!isPerLegRedundant(
                    snapshotContributors(leg.contributors ?? leg.attributions ?? []),
                    selectedAttributions,
                  ) && (
                    <Box sx={{ mt: 0.5 }}>
                      <AttributionStrip
                        attributions={snapshotContributors(
                          leg.contributors ?? leg.attributions ?? [],
                        )}
                        variant="inline"
                      />
                    </Box>
                  )}
                </Box>
              )}
              <LegStatusDetails leg={leg} itinerary={itinerary} />
            </TimelineRow>
            {stops}
            {/* Interchange summary after a ride that changes onto another. When a
                walk leg follows, its own row shows the walk, so suppress it here. */}
            {transfer && (
              <TimelineRow through={INTERCHANGE} divider>
                <TransitTransferSummary
                  fromLeg={leg}
                  nextLeg={transfer.nextLeg}
                  walkSeconds={legs[i + 1]?.mode === "walking" ? 0 : transfer.walkSeconds}
                />
              </TimelineRow>
            )}
            {/* Arrival at the trip's end */}
            {i === legs.length - 1 && (
              <TimelineRow
                above={segment}
                divider
                node={<DestinationNode />}
                time={
                  <LiveStopTime
                    time={legTransitTime(leg, "arrival")}
                    event="arrival"
                    tripId={liveTrip(!isWalk ? leg.tripId : undefined)}
                    stopId={leg.to.stopId}
                    emphasis
                  />
                }
              >
                <StopRow onClick={onStopClick && (() => onStopClick(leg.to))}>
                  <PointName
                    name={tripPlaceName(leg.to, destinationLabel)}
                    platform={!isWalk ? legPlatform(leg, i, "arrival") : undefined}
                    level={!isWalk ? leg.to.level : undefined}
                  />
                </StopRow>
              </TimelineRow>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** The walk between two platforms of an interchange. */
const INTERCHANGE: RailSegment = { color: "#9E9E9E", dotted: true };

/** How a leg is drawn on the rail: rides in their line's colour, the rest as dots. */
export function railSegment(leg: TripLeg | undefined): RailSegment | undefined {
  if (!leg) return undefined;
  const street = STREET_LEG[leg.mode];
  if (street) return { color: street.color, dotted: true };
  return { color: routeColor({ color: leg.route?.color, mode: leg.mode }), dotted: false };
}

const MODE_ICON: Partial<Record<TransportMode, SvgIconComponent>> = {
  rail: TrainIcon,
  subway: SubwayIcon,
  tram: TramIcon,
  ferry: DirectionsBoatIcon,
  other: CommuteIcon,
};

/**
 * The marker where the trip reaches a point: the mode of the ride that leaves
 * there, a ring where a ride ends, and the trip's own start as a plain ring.
 */
function pointNode(previous: TripLeg | undefined, leg: TripLeg, tripStart: boolean): ReactNode {
  const leaving = railSegment(leg);
  if (leaving && !leaving.dotted) {
    const Icon = MODE_ICON[leg.mode] ?? DirectionsBusIcon;
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: "50%",
          bgcolor: leaving.color,
          border: "2px solid",
          borderColor: "background.paper",
          color: "#fff",
        }}
      >
        <Icon sx={{ fontSize: 16 }} />
      </Box>
    );
  }
  const arriving = railSegment(previous);
  if (arriving && !arriving.dotted) return <RailDot color={arriving.color} />;
  return <RailDot color={tripStart ? "text.primary" : "#9E9E9E"} size={14} />;
}

function StreetNode({ Icon }: { Icon: SvgIconComponent }) {
  return (
    <Box sx={{ display: "flex", p: 0.25, borderRadius: "50%", bgcolor: "background.paper" }}>
      <Icon sx={{ fontSize: 20, color: "text.secondary" }} />
    </Box>
  );
}

function DestinationNode() {
  return (
    <Box sx={{ display: "flex", borderRadius: "50%", bgcolor: "background.paper" }}>
      <LocationOnIcon sx={{ fontSize: 28, color: "#EA4335" }} />
    </Box>
  );
}

function PointName({
  name,
  platform,
  level,
}: {
  name: string;
  platform?: LegPlatformInfo;
  level?: number | null;
}) {
  const tNav = useTranslations("navigation");
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
      <Typography variant="body1" sx={{ fontWeight: 500, lineHeight: 1.5 }}>
        {name}
      </Typography>
      {platform && <LegPlatform {...platform} />}
      {level != null && level !== 0 && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {tNav("levelShort", { level })}
        </Typography>
      )}
    </Box>
  );
}

interface LegPlatformInfo {
  code?: string;
  scheduledCode?: string;
  changed?: boolean;
}

function plannedPlatform(
  leg: TripLeg,
  _index: number,
  event: "departure" | "arrival",
): LegPlatformInfo {
  const place = event === "departure" ? leg.from : leg.to;
  return { code: place.platformCode, changed: !!changedFromPlatform(place) };
}

function LegPlatform({ code, scheduledCode, changed }: LegPlatformInfo) {
  return code ? (
    <PlatformBadge code={code} scheduledCode={scheduledCode} changed={changed} />
  ) : null;
}

/** A stop's name, which opens it when the timeline is interactive. */
function StopRow({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  if (!onClick) return <>{children}</>;
  return (
    <ClickableRow sx={{ minWidth: 0, "&:hover": { opacity: 0.7 } }} onClick={onClick}>
      {children}
    </ClickableRow>
  );
}

/** A transit leg's line name, which opens the trip's departures when it has a known trip. */
function LegLineLabel({ onOpen, children }: { onOpen?: () => void; children: ReactNode }) {
  const sx = { display: "inline-flex", alignItems: "center", gap: 0.5 } as const;
  return onOpen ? (
    <ClickableRow onClick={onOpen} sx={{ ...sx, width: "auto", "&:hover": { opacity: 0.75 } }}>
      {children}
    </ClickableRow>
  ) : (
    <Box sx={sx}>{children}</Box>
  );
}
