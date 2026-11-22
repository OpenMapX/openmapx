"use client";

import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import ScheduleIcon from "@mui/icons-material/Schedule";
import TwoWheelerIcon from "@mui/icons-material/TwoWheeler";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type {
  PersonalVehicle,
  RoadConditionRouteImpact,
  Route,
  RouteImpact,
  RouteImpactUnavailableReason,
} from "@openmapx/core";
import {
  buildElevationProfile,
  estimateDrivingCo2Grams,
  formatDuration,
  formatOverviewDistance,
  roadConditionRouteNotice,
  tzDiffMinutes,
  tzOffsetLabel,
  useDirectionsStore,
  viewerTimeZone,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { RouteImpactBadge } from "@/components/panels/directions/RouteImpactBadge";
import {
  type RouteImpactAssumptions,
  RouteImpactDetailsDialog,
} from "@/components/panels/directions/RouteImpactDetailsDialog";
import { BRAND, TRAFFIC_TEXT_COLOR } from "@/integration-api/runtime/theme";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { formatCo2Emission } from "@/lib/formatCo2";
import { useNow } from "@/lib/useNow";
import { useRouteTrafficPresentation } from "@/lib/useRouteTrafficPresentation";
import { VISUALLY_HIDDEN } from "@/lib/visuallyHidden";
import { RouteTrafficStatus } from "./RouteTrafficStatus";
import { type RouteArrivalContext, resolveRouteArrival } from "./routeArrival";
import {
  isInteractiveCardTarget,
  RouteCardActions,
  RouteStartError,
  routeCardFrameSx,
} from "./routeCardChrome";
import { useGroundRouteStart } from "./useGroundRouteStart";

function RouteArrivalCaption({
  context,
  durationSeconds,
  id,
}: {
  context: RouteArrivalContext;
  durationSeconds: number;
  id: string;
}) {
  const t = useTranslations("directions");
  const fmt = useDateTimeFormat();
  const nowMs = useNow(60_000);
  const resolved = resolveRouteArrival(context, durationSeconds, nowMs);
  if (!resolved) return null;

  const viewerZone = viewerTimeZone();
  const destinationZone = context.destinationTimeZone;
  const destinationOffset = destinationZone ? tzOffsetLabel(resolved.at, destinationZone) : null;
  const displayZone = destinationOffset ? (destinationZone as string) : viewerZone;
  const zoneOption = { timeZone: displayZone };
  const time =
    fmt.date(resolved.at, zoneOption) === fmt.date(nowMs, zoneOption)
      ? fmt.time(resolved.at, zoneOption)
      : fmt.dateTime(resolved.at, zoneOption);
  const showOffset = destinationOffset && tzDiffMinutes(resolved.at, viewerZone, displayZone) !== 0;

  return (
    <Box
      id={id}
      data-testid="route-arrival"
      sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.25, color: "text.secondary" }}
    >
      <ScheduleIcon aria-hidden sx={{ fontSize: 14 }} />
      <Typography variant="caption" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {t(resolved.isDeadline ? "arrivalDeadline" : "estimatedArrival", { time })}
        {showOffset ? ` · ${destinationOffset}` : ""}
      </Typography>
    </Box>
  );
}

export interface RouteCardProps {
  route: Route;
  index: number;
  active: boolean;
  /** Scheduled cards only peek at the sheet; ordinary cards select one alternative. */
  selectionKind?: "route" | "peek";
  /** Whether this route has the shortest provider-reported duration. */
  isFastest?: boolean;
  onSelect: () => void;
  onDetails: () => void;
  units: "metric" | "imperial";
  /** The other routes, carried into navigation so they can be switched to mid-trip. */
  alternatives?: Route[];
  /** Integration id of the routing provider that served this route, for nav attribution. */
  provider?: string;
  roadConditionImpact?: RoadConditionRouteImpact;
  impact?: RouteImpact;
  impactUnavailableReason?: RouteImpactUnavailableReason | null;
  vehicles?: PersonalVehicle[];
  onUpdateAssumptions?: (assumptions: RouteImpactAssumptions) => void;
  arrivalContext?: RouteArrivalContext;
}

export function RouteCard({
  route,
  index,
  active,
  selectionKind = "route",
  isFastest = false,
  onSelect,
  onDetails,
  units,
  alternatives = [],
  provider,
  roadConditionImpact,
  impact,
  impactUnavailableReason,
  vehicles,
  onUpdateAssumptions,
  arrivalContext,
}: RouteCardProps) {
  const t = useTranslations("directions");
  const tTraffic = useTranslations("trafficStatus");
  const locale = useLocale();
  const waypoints = useDirectionsStore((s) => s.waypoints);
  const { canStart, start, starting, startError } = useGroundRouteStart({
    route,
    waypoints,
    index,
    alternatives,
    provider,
    roadConditionImpact,
    units,
  });
  const [impactDetailsOpen, setImpactDetailsOpen] = useState(false);
  const arrivalCaptionId = useId();
  const trafficCaptionId = useId();
  const traffic = useRouteTrafficPresentation(route);
  const selectionDescription =
    [
      route.mode === "driving" && arrivalContext ? arrivalCaptionId : null,
      (route.mode === "driving" || route.mode === "motorcycle") && traffic.kind !== "clear"
        ? trafficCaptionId
        : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const roadConditionNotice = roadConditionRouteNotice(roadConditionImpact);

  const dist = formatOverviewDistance(route.distance, units);

  const ascentMeters = useMemo(() => {
    if (
      (route.mode !== "walking" && route.mode !== "cycling") ||
      route.geometry.length < 2 ||
      !route.elevation ||
      route.elevation.length < 2 ||
      !route.elevation.every(Number.isFinite)
    ) {
      return null;
    }
    return buildElevationProfile(route.geometry, route.elevation, route.elevationInterval ?? 30)
      .stats.totalAscent;
  }, [route]);
  const ascentLabel =
    ascentMeters === null
      ? null
      : t("routeAscent", {
          height:
            units === "imperial"
              ? `${Math.round(ascentMeters * 3.28084)} ft`
              : `${Math.round(ascentMeters)} m`,
        });

  const modeIcon =
    route.mode === "driving" ? (
      <DirectionsCarIcon sx={{ fontSize: 22, color: active ? BRAND : "text.disabled" }} />
    ) : route.mode === "walking" ? (
      <DirectionsWalkIcon sx={{ fontSize: 22, color: active ? BRAND : "text.disabled" }} />
    ) : route.mode === "motorcycle" ? (
      <TwoWheelerIcon sx={{ fontSize: 22, color: active ? BRAND : "text.disabled" }} />
    ) : (
      <DirectionsBikeIcon sx={{ fontSize: 22, color: active ? BRAND : "text.disabled" }} />
    );

  const selectionLabel = `${route.summary ?? t("bestRoute")}, ${formatDuration(route.duration, locale)}, ${dist}${ascentLabel ? `, ${ascentLabel}` : ""}`;
  const summaryContent = (
    <>
      <Typography
        variant="h6"
        sx={{
          color:
            route.mode === "driving" || route.mode === "motorcycle"
              ? traffic.kind === "delay"
                ? TRAFFIC_TEXT_COLOR[traffic.band]
                : traffic.kind === "clear"
                  ? BRAND
                  : "text.primary"
              : active
                ? BRAND
                : "text.primary",
          fontWeight: 700,
          lineHeight: 1.25,
          fontVariantNumeric: "tabular-nums",
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          columnGap: 0.5,
          pr: route.mode === "driving" || route.mode === "motorcycle" ? 4 : 0,
          py: route.mode === "driving" || route.mode === "motorcycle" ? 0.5 : 0,
        }}
      >
        <span>{formatDuration(route.duration, locale)}</span>
        {traffic.kind === "delay" && (
          <Typography
            component="span"
            variant="caption"
            id={trafficCaptionId}
            data-testid="traffic-delay"
            sx={{ color: "inherit", fontWeight: 500, whiteSpace: "nowrap", lineHeight: 1.35 }}
          >
            {" "}
            ({tTraffic("delay", { delay: formatDuration(traffic.seconds, locale) })})
          </Typography>
        )}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, mt: 0.25, minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{ color: "text.secondary", flex: 1, minWidth: 0 }}>
          {route.summary ?? t("bestRoute")}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", flexShrink: 0 }}>
          {dist}
        </Typography>
      </Box>
      {route.mode === "driving" && arrivalContext && (
        <RouteArrivalCaption
          context={arrivalContext}
          durationSeconds={route.duration}
          id={arrivalCaptionId}
        />
      )}
      {ascentLabel && (
        <Typography
          variant="caption"
          data-testid="route-ascent"
          sx={{ color: "text.secondary", display: "block", mt: 0.25 }}
        >
          {ascentLabel}
        </Typography>
      )}
      {/* Route-level notes belong to the chosen route; alternatives stay a
          compact comparison of time, way and distance. */}
      {active && roadConditionNotice && (
        <Typography
          variant="caption"
          data-testid="road-condition-route-status"
          sx={{ color: "text.secondary", display: "block", mt: 0.25 }}
        >
          {t(`roadConditionNotice.${roadConditionNotice}`)}
        </Typography>
      )}
      {route.usesLocalAccessRoad && (
        <Typography
          variant="caption"
          data-testid="local-access-route-status"
          sx={{ color: "text.secondary", display: "block", mt: 0.25 }}
        >
          {t("localAccessRoad")}
        </Typography>
      )}
    </>
  );

  const selectionSx = {
    display: "block",
    width: "100%",
    p: 0,
    border: 0,
    bgcolor: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left" as const,
    cursor: "pointer",
    borderRadius: 1,
    "&:focus-visible, &:focus-within": {
      outline: "2px solid",
      outlineColor: "primary.main",
      outlineOffset: 2,
    },
  };

  return (
    // The whole card is a pointer target for the route's radio or peek button,
    // which is the keyboard path.
    // biome-ignore lint/plugin/noClickableLayoutElement: pointer shortcut for the selection control
    <Box
      onClick={(event) => {
        if (!isInteractiveCardTarget(event.target)) onSelect();
      }}
      sx={{ ...routeCardFrameSx(active), display: "flex", gap: 1.5 }}
    >
      <Box
        sx={{
          flexShrink: 0,
          mt: route.mode === "driving" || route.mode === "motorcycle" ? 0.75 : 0.25,
        }}
      >
        {modeIcon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ position: "relative" }}>
          {selectionKind === "peek" ? (
            <Box
              component="button"
              type="button"
              aria-label={selectionLabel}
              aria-describedby={selectionDescription}
              onClick={onSelect}
              sx={selectionSx}
            >
              {summaryContent}
            </Box>
          ) : (
            <Box component="label" sx={{ ...selectionSx, position: "relative" }}>
              <Box
                component="input"
                type="radio"
                name="alternative-route"
                aria-label={selectionLabel}
                aria-describedby={selectionDescription}
                checked={active}
                onChange={onSelect}
                onClick={() => {
                  if (active) onSelect();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onSelect();
                }}
                sx={{ position: "absolute", opacity: 0, width: "1px", height: "1px", m: 0 }}
              />
              {summaryContent}
            </Box>
          )}
          <Box sx={{ position: "absolute", right: "-13px", top: "-9px" }}>
            <RouteTrafficStatus route={route} impact={roadConditionImpact} provider={provider} />
          </Box>
        </Box>
        {(route.mode === "driving" || route.mode === "motorcycle") &&
          traffic.kind === "unavailable" && (
            <Box
              id={trafficCaptionId}
              component="span"
              data-testid="route-traffic-status"
              sx={VISUALLY_HIDDEN}
            >
              {tTraffic("summary")}
            </Box>
          )}
        {!active ? null : impact ? (
          // biome-ignore lint/plugin/noClickableLayoutElement: keeps the badge's click from selecting the route
          <Box
            sx={{ mt: 0.5 }}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <RouteImpactBadge impact={impact} onClick={() => setImpactDetailsOpen(true)} />
          </Box>
        ) : impactUnavailableReason ? (
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {t(
              impactUnavailableReason === "plugin_hybrid_inputs_missing"
                ? "impactPluginHybridUnavailable"
                : "impactUnsupportedPowertrain",
            )}
          </Typography>
        ) : route.mode === "driving" ? (
          (() => {
            const co2 = formatCo2Emission(estimateDrivingCo2Grams(route.distance), locale);
            return co2 ? (
              <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
                {t("co2Estimate", { co2 })}
              </Typography>
            ) : null;
          })()
        ) : null}
        {active && (impact ? impact.comparison?.isFastest === true : isFastest) && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: "block",
            }}
          >
            {t("fastestRoute")}
          </Typography>
        )}
        {active && (
          <RouteCardActions
            onDetails={onDetails}
            onStart={canStart ? () => void start() : undefined}
            // A second tap while the shell is still preparing would start a
            // second session nobody is watching.
            startDisabled={starting}
          />
        )}
        <RouteStartError error={startError} />
      </Box>
      {impact && (
        // biome-ignore lint/plugin/noClickableLayoutElement: keeps dialog clicks from selecting the route
        <Box onClick={(e) => e.stopPropagation()}>
          <RouteImpactDetailsDialog
            open={impactDetailsOpen}
            onClose={() => setImpactDetailsOpen(false)}
            impact={impact}
            vehicles={vehicles}
            onUpdateAssumptions={onUpdateAssumptions}
          />
        </Box>
      )}
    </Box>
  );
}
