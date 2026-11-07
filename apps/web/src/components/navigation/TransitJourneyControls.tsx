"use client";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import ErrorOutlinedIcon from "@mui/icons-material/ErrorOutlined";
import GpsNotFixedIcon from "@mui/icons-material/GpsNotFixed";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import UndoIcon from "@mui/icons-material/Undo";
import UpdateDisabledIcon from "@mui/icons-material/UpdateDisabled";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { haversineDistance, useNavigationStore } from "@openmapx/core";
import { selectLegPlatform } from "@openmapx/core/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { DepartureTime } from "@/components/panels/transit/DepartureTime";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { useTransitRiderAction } from "@/lib/mobile/useTransitRiderAction";
import { legTransitTime, transitDelayMinutes } from "@/lib/transitTime";
import { useNow } from "@/lib/useNow";

function RiderNotice({
  children,
  severity,
}: {
  children: ReactNode;
  severity: "info" | "warning" | "error";
}) {
  const Icon =
    severity === "error"
      ? ErrorOutlinedIcon
      : severity === "warning"
        ? WarningAmberIcon
        : InfoOutlinedIcon;
  return (
    <Box
      role="status"
      sx={{
        display: "flex",
        gap: 0.75,
        alignItems: "flex-start",
        py: 0.75,
        borderTop: "1px solid",
        borderColor: "divider",
      }}
    >
      <Icon
        sx={{
          fontSize: 18,
          flexShrink: 0,
          mt: 0.15,
          color: severity === "error" ? "error.main" : "text.secondary",
        }}
      />
      <Typography variant="caption">{children}</Typography>
    </Box>
  );
}
export function TransitJourneyControls({
  onAlternatives,
  walkRepair,
  showRidingDestination = true,
}: {
  onAlternatives: () => void;
  showRidingDestination?: boolean;
  walkRepair?: "idle" | "repairing" | "unavailable" | "accessibility";
}) {
  const t = useTranslations("navigation");
  const now = useNow(5000);
  const liveUnavailable = useNavigationStore((s) => s.liveDataUnavailable);
  const refreshUnavailable = useNavigationStore((s) => s.transitRefreshUnavailable);
  const itinerary = useNavigationStore((s) => s.itinerary);
  const captures = useNavigationStore((s) => s.transitCaptures);
  const p = useNavigationStore((s) => s.transitProgress);
  const act = useTransitRiderAction();
  const runtime = useMobileRuntime();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!itinerary) return null;
  const current = p?.currentLegIndex ?? 0;
  const leg = itinerary.legs[current];
  const riding = p?.phase === "riding";
  const arrived = p?.arrived;
  const rideIndex = leg?.tripId || leg?.route ? current : current + 1;
  const ride = itinerary.legs[rideIndex];
  const canBoard =
    !!ride &&
    (!!ride.tripId || !!ride.route) &&
    !ride.cancelled &&
    !arrived &&
    p?.phase !== "transferring";
  const supported = runtime.browserAuthority || runtime.capabilities?.transitActions;
  const run = async (type: "board" | "alight" | "continue" | "undo") => {
    setPending(true);
    setFailed(false);
    try {
      await act({
        type,
        legIndex:
          type === "undo" ? (p?.lastActionLegIndex ?? current) : riding ? current : rideIndex,
      });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const departureTime = ride ? legTransitTime(ride) : {};
  const boarding = ride ? selectLegPlatform(ride, rideIndex, captures, "departure") : undefined;
  const timeChanged = (transitDelayMinutes(departureTime) ?? 0) !== 0;
  const departure = ride?.startTime ? new Date(ride.startTime).getTime() : NaN;
  const liveDeparture =
    !liveUnavailable &&
    (!runtime.browserAuthority || (!!itinerary.refreshToken && !refreshUnavailable));
  const departurePassed =
    !riding && canBoard && Number.isFinite(departure) && now > departure + 120000;
  const uncertain = p?.confidence === "uncertain" || p?.confidence === "stale";
  const boardedNudge =
    !riding &&
    canBoard &&
    rideIndex === p?.currentLegIndex &&
    p?.phase === "waiting-to-board" &&
    p?.position &&
    p.deviationMeters < 75 &&
    haversineDistance(p.position, [ride.from.lng, ride.from.lat]) > 150;
  const alightNudge =
    riding && p?.position && haversineDistance(p.position, [leg.to.lng, leg.to.lat]) < 75;
  const undoAvailable = p?.canUndo && (!p.lastActionAtMs || now - p.lastActionAtMs <= 120000);
  const walking = leg?.mode === "walking";
  const recovering = !riding && (!!ride?.cancelled || !!p?.offPlan);
  if (arrived && !undoAvailable) return null;
  return (
    <Box
      component="section"
      aria-label={t("selectedConnection")}
      aria-busy={pending}
      sx={{ px: 2, pt: 0.5, pb: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}
    >
      {!riding && canBoard && (
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="subtitle1"
              sx={{ fontWeight: 600, lineHeight: 1.4, overflowWrap: "anywhere" }}
            >
              {ride.from.name}
            </Typography>
            {
              <Box
                sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", mt: 0.5 }}
              >
                {ride.route ? (
                  <RouteBadge
                    shortName={ride.route.shortName || ride.route.longName || ""}
                    mode={ride.mode}
                    color={ride.route.color}
                    textColor={ride.route.textColor}
                  />
                ) : (
                  <DirectionsTransitIcon sx={{ fontSize: 20 }} />
                )}
                <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  {ride.headsign ?? ride.to.name}
                </Typography>
                {boarding?.code && (
                  <PlatformBadge
                    code={boarding.code}
                    scheduledCode={boarding.scheduledCode}
                    changed={boarding.changed}
                  />
                )}
              </Box>
            }
          </Box>
          <Box sx={{ textAlign: "right", flexShrink: 0, maxWidth: 120 }}>
            {Number.isFinite(departure) ? (
              <DepartureTime {...departureTime} variant="subtitle1" fontWeight={700} />
            ) : (
              <Typography variant="subtitle1">{t("timeUnknown")}</Typography>
            )}
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", lineHeight: 1.4 }}
            >
              {t(
                ride.realtime && liveDeparture
                  ? "departureLive"
                  : !ride.realtime && !timeChanged
                    ? "departureScheduled"
                    : "departureLastKnown",
              )}
            </Typography>
          </Box>
        </Box>
      )}
      {riding && showRidingDestination && !alightNudge && (
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {t("alightAt", { place: leg.to.name })}
        </Typography>
      )}
      {walkRepair && walkRepair !== "idle" && (
        <Typography variant="caption" color="text.secondary" role="status">
          {t(`transitWalkRepair.${walkRepair}`)}
        </Typography>
      )}
      {departurePassed && (
        <Typography variant="body2" color="warning.main" role="status">
          {t("departurePassed")}
        </Typography>
      )}
      {boardedNudge && (
        <Typography variant="caption" color="text.secondary">
          {t("boardPrompt")}
        </Typography>
      )}
      {alightNudge && showRidingDestination && (
        <Typography variant="caption" color="text.secondary">
          {t("alightPrompt")}
        </Typography>
      )}
      {uncertain && (
        <Box
          sx={{ display: "flex", gap: 0.75, alignItems: "flex-start", color: "text.secondary" }}
          role="status"
        >
          <GpsNotFixedIcon sx={{ fontSize: 18, flexShrink: 0, mt: 0.15 }} />
          <Typography variant="caption">
            {t(
              p?.confidence === "stale"
                ? "transitGpsStale"
                : walking
                  ? "transitWalkPositionUncertain"
                  : "transitProgressUncertain",
            )}
          </Typography>
        </Box>
      )}
      {p?.offPlan && <RiderNotice severity="warning">{t("alightedElsewhere")}</RiderNotice>}
      {!supported && <RiderNotice severity="info">{t("transitActionsUpdateRequired")}</RiderNotice>}
      {liveUnavailable && (
        <Box
          sx={{ display: "flex", gap: 0.75, alignItems: "flex-start", color: "text.secondary" }}
          role="status"
        >
          <UpdateDisabledIcon sx={{ fontSize: 18, flexShrink: 0, mt: 0.15 }} />
          <Typography variant="caption">{t("transitLiveUpdatesUnavailable")}</Typography>
        </Box>
      )}
      {failed && <RiderNotice severity="error">{t("transitActionFailed")}</RiderNotice>}
      {riding && itinerary.legs[current + 1]?.interlineWithPrevious && (
        <Button
          variant="outlined"
          disabled={pending || !supported}
          onClick={() => void run("continue")}
          sx={{ minHeight: 44, borderRadius: "999px" }}
        >
          {t("stayOnBoard")}
        </Button>
      )}
      <Box sx={{ display: "flex", gap: 1, alignItems: "stretch", flexWrap: "wrap" }}>
        {!arrived && (riding || canBoard) && (
          <Button
            variant={!walking && (!riding || alightNudge) ? "contained" : "outlined"}
            disableElevation
            startIcon={riding ? <DirectionsWalkIcon /> : <DirectionsTransitIcon />}
            loading={pending}
            disabled={pending || !supported}
            onClick={() => void run(riding ? "alight" : "board")}
            sx={{
              minHeight: 44,
              flex: "1 1 140px",
              minWidth: 0,
              lineHeight: 1.4,
              py: 1,
              borderRadius: "999px",
            }}
          >
            {t(riding ? "confirmAlight" : "confirmBoard")}
          </Button>
        )}
        {!arrived && (
          <Button
            startIcon={<AltRouteIcon />}
            variant={recovering ? "contained" : "text"}
            disableElevation
            aria-label={t("findTransitAlternatives")}
            onClick={onAlternatives}
            disabled={pending}
            sx={{
              minHeight: 44,
              flex: "0 0 auto",
              px: 1.25,
              borderRadius: "999px",
            }}
          >
            {t("transitAlternativesShort")}
          </Button>
        )}
        {arrived && undoAvailable && (
          <Button
            startIcon={<UndoIcon />}
            disabled={pending || !supported}
            onClick={() => void run("undo")}
            sx={{ minHeight: 44, flex: 1, borderRadius: "999px" }}
          >
            {t("undoTransitAction")}
          </Button>
        )}
      </Box>
      {!arrived && undoAvailable && (
        <Button
          startIcon={<UndoIcon />}
          size="small"
          disabled={pending || !supported}
          onClick={() => void run("undo")}
          sx={{ alignSelf: "flex-end", minHeight: 44, mt: -0.75, mb: -0.75, borderRadius: "999px" }}
        >
          {t("undoTransitAction")}
        </Button>
      )}
    </Box>
  );
}
