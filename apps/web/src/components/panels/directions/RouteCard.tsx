"use client";

import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import NavigationIcon from "@mui/icons-material/Navigation";
import ScheduleIcon from "@mui/icons-material/Schedule";
import TwoWheelerIcon from "@mui/icons-material/TwoWheeler";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
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
  formatDistance,
  formatDuration,
  roadConditionRouteNotice,
  tzDiffMinutes,
  tzOffsetLabel,
  useDirectionsStore,
  useSettingsStore,
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
import { useStartNavigation } from "@/lib/mobile/useStartNavigation";
import { primeSpeechSynthesis } from "@/lib/navigation/useNavigationVoice";
import { requestHeadingPermission } from "@/lib/useHeading";
import { useNow } from "@/lib/useNow";
import { useRouteTrafficPresentation } from "@/lib/useRouteTrafficPresentation";
import { RouteTrafficStatus } from "./RouteTrafficStatus";
import { type RouteArrivalContext, resolveRouteArrival } from "./routeArrival";

const GROUND_MODES = new Set<Route["mode"]>(["driving", "walking", "cycling", "motorcycle"]);

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
  const tc = useTranslations("common");
  const tNav = useTranslations("navigation");
  const locale = useLocale();
  const { startGround } = useStartNavigation();
  const waypoints = useDirectionsStore((s) => s.waypoints);
  const avoidHighways = useDirectionsStore((s) => s.avoidHighways);
  const avoidTolls = useDirectionsStore((s) => s.avoidTolls);
  const avoidFerries = useDirectionsStore((s) => s.avoidFerries);
  const avoidIncidents = useSettingsStore((s) => s.avoidIncidents);
  // Only meaningful under native authority, where Start is a round trip rather
  // than a synchronous store write.
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
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

  const handleStart = async () => {
    const coords = waypoints.map((w) => w.coords).filter((c): c is [number, number] => c !== null);
    if (coords.length < 2) return;
    // Unlock TTS inside the user gesture (iOS Safari requirement) before any
    // await hands control back to the event loop.
    primeSpeechSynthesis();
    if (starting) return;
    setStarting(true);
    try {
      const result = await startGround(
        {
          route,
          alternatives,
          mode: route.mode,
          destinationWaypoints: coords,
          routeProvider: provider,
          routeSelectionIntent: index === 0 ? "automatic" : "userSelected",
          routeOptions: {
            avoidHighways: route.mode === "driving" && avoidHighways,
            avoidTolls: route.mode === "driving" && avoidTolls,
            avoidFerries,
            avoidClosures: avoidIncidents,
          },
          roadConditionImpact,
          locale: locale === "de" ? "de" : "en",
          units,
        },
        // Between prepare and start, so the OS prompt is spent on a trip the
        // shell has already accepted.
        {
          onPrepared: async () => {
            await requestHeadingPermission();
          },
        },
      );
      setStartError(result.ok ? null : result.code);
    } finally {
      setStarting(false);
    }
  };

  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

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

  const selectionLabel = `${route.summary ?? t("bestRoute")}, ${formatDuration(route.duration)}, ${dist}${ascentLabel ? `, ${ascentLabel}` : ""}`;
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
        }}
      >
        {formatDuration(route.duration)}
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
      {roadConditionNotice && (
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
    <Box
      onClick={(event) => {
        if (!(event.target as Element).closest("button, input, label, a, [role='button']"))
          onSelect();
      }}
      sx={{
        display: "flex",
        gap: 1.5,
        px: 2,
        py: 1.5,
        cursor: "pointer",
        borderLeft: active ? `4px solid ${BRAND}` : "4px solid transparent",
        bgcolor: active ? "rgba(0,123,139,0.04)" : "transparent",
        "&:hover": { bgcolor: active ? "rgba(0,123,139,0.07)" : "action.hover" },
        transition: "background-color 0.15s",
      }}
    >
      <Box sx={{ flexShrink: 0, mt: 0.25 }}>{modeIcon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
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
        <RouteTrafficStatus
          id={trafficCaptionId}
          route={route}
          impact={roadConditionImpact}
          provider={provider}
        />
        {impact ? (
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
          <Box sx={{ mt: 0.5, ml: -1.5, display: "flex", alignItems: "center", gap: 0.5 }}>
            <Typography
              component="button"
              type="button"
              variant="caption"
              sx={{
                color: BRAND,
                cursor: "pointer",
                fontWeight: 500,
                px: 1.5,
                py: 0.75,
                borderRadius: 99,
                border: 0,
                bgcolor: "transparent",
                "&:hover": { bgcolor: `${BRAND}18` },
                "&:focus-visible": {
                  outline: "2px solid",
                  outlineColor: "primary.main",
                  outlineOffset: 2,
                },
                transition: "background-color 0.15s",
              }}
              onClick={(e) => {
                e.stopPropagation();
                onDetails();
              }}
            >
              {tc("details")}
            </Typography>
            {GROUND_MODES.has(route.mode) && (
              <Button
                size="small"
                variant="contained"
                startIcon={<NavigationIcon />}
                // A second tap while the shell is still preparing would start a
                // second session nobody is watching.
                disabled={starting}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleStart();
                }}
                sx={{
                  bgcolor: BRAND,
                  textTransform: "none",
                  borderRadius: 99,
                  "&:hover": { bgcolor: BRAND },
                }}
              >
                {tNav("start")}
              </Button>
            )}
          </Box>
        )}
        {startError && (
          <Typography role="alert" sx={{ fontSize: 12, color: "error.main", mt: 0.5 }}>
            {tNav(startError === "incompatible" ? "startUpdateRequired" : "startFailed")}
          </Typography>
        )}
      </Box>
      {impact && (
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
