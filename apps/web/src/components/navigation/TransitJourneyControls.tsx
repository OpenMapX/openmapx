"use client";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import GpsNotFixedIcon from "@mui/icons-material/GpsNotFixed";
import UndoIcon from "@mui/icons-material/Undo";
import UpdateDisabledIcon from "@mui/icons-material/UpdateDisabled";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { haversineDistance, useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { useTransitRiderAction } from "@/lib/mobile/useTransitRiderAction";
import { useNow } from "@/lib/useNow";
export function TransitJourneyControls({
  onAlternatives,
  walkRepair,
}: {
  onAlternatives: () => void;
  walkRepair?: "idle" | "repairing" | "unavailable" | "accessibility";
}) {
  const t = useTranslations("navigation");
  const fmt = useDateTimeFormat();
  const now = useNow(5000);
  const liveUnavailable = useNavigationStore((s) => s.liveDataUnavailable);
  const itinerary = useNavigationStore((s) => s.itinerary);
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
  const departure = ride?.startTime ? new Date(ride.startTime).getTime() : NaN;
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
      sx={{ px: 2, pt: 1.5, pb: 1.5, display: "flex", flexDirection: "column", gap: 1.25 }}
    >
      {!riding && canBoard && (
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1.5 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary">
              {t("selectedConnection")}
            </Typography>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, lineHeight: 1.4 }}>
              {ride.from.name}
            </Typography>
            {walking && (
              <Box
                sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", mt: 0.5 }}
              >
                <RouteBadge
                  shortName={ride.route?.shortName ?? ""}
                  mode={ride.mode}
                  color={ride.route?.color}
                  textColor={ride.route?.textColor}
                />
                <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  {ride.headsign ?? ride.to.name}
                </Typography>
                {ride.from.platformCode && (
                  <PlatformBadge
                    code={ride.from.platformCode}
                    scheduledCode={ride.from.scheduledPlatformCode}
                  />
                )}
              </Box>
            )}
          </Box>
          <Box sx={{ textAlign: "right", flexShrink: 0, maxWidth: 120 }}>
            <Typography
              variant="subtitle1"
              sx={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", lineHeight: 1.4 }}
            >
              {Number.isFinite(departure) ? fmt.time(departure) : t("timeUnknown")}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", lineHeight: 1.4 }}
            >
              {t(ride.realtime ? "departureLive" : "departureScheduled")}
            </Typography>
          </Box>
        </Box>
      )}
      {riding && !alightNudge && (
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
      {alightNudge && (
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
            {t(p?.confidence === "stale" ? "transitGpsStale" : "transitProgressUncertain")}
          </Typography>
        </Box>
      )}
      {p?.offPlan && (
        <Alert severity="warning" sx={{ py: 0 }}>
          {t("alightedElsewhere")}
        </Alert>
      )}
      {!supported && (
        <Alert severity="info" sx={{ py: 0 }}>
          {t("transitActionsUpdateRequired")}
        </Alert>
      )}
      {liveUnavailable && (
        <Box
          sx={{ display: "flex", gap: 0.75, alignItems: "flex-start", color: "text.secondary" }}
          role="status"
        >
          <UpdateDisabledIcon sx={{ fontSize: 18, flexShrink: 0, mt: 0.15 }} />
          <Typography variant="caption">{t("transitLiveUpdatesUnavailable")}</Typography>
        </Box>
      )}
      {failed && (
        <Alert severity="error" sx={{ py: 0 }}>
          {t("transitActionFailed")}
        </Alert>
      )}
      {riding && itinerary.legs[current + 1]?.interlineWithPrevious && (
        <Button
          variant="outlined"
          disabled={pending || !supported}
          onClick={() => void run("continue")}
          sx={{ minHeight: 44 }}
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
            sx={{ minHeight: 44, flex: "1 1 180px", minWidth: 0, lineHeight: 1.4, py: 1 }}
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
              flex: "1 0 auto",
              flexShrink: 0,
              px: 1.25,
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
            sx={{ minHeight: 44, flex: 1 }}
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
          sx={{ alignSelf: "flex-end", minHeight: 44, mt: -0.75, mb: -0.75 }}
        >
          {t("undoTransitAction")}
        </Button>
      )}
    </Box>
  );
}
