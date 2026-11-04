"use client";
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
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        color: "text.primary",
        borderRadius: 2,
        boxShadow: 3,
        p: 1.5,
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
    >
      {!riding && canBoard && (
        <Box>
          <Typography variant="overline" color="text.secondary">
            {t("selectedConnection")}
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <RouteBadge
              shortName={ride.route?.shortName ?? ""}
              mode={ride.mode}
              color={ride.route?.color}
              textColor={ride.route?.textColor}
            />
            <Typography variant="subtitle2">{ride.headsign ?? ride.to.name}</Typography>
            {ride.from.platformCode && (
              <PlatformBadge
                code={ride.from.platformCode}
                scheduledCode={ride.from.scheduledPlatformCode}
              />
            )}
          </Box>
          <Typography variant="body2">
            {ride.from.name} · {Number.isFinite(departure) ? fmt.time(departure) : t("timeUnknown")}{" "}
            · {t(ride.realtime ? "departureLive" : "departureScheduled")}
          </Typography>
        </Box>
      )}
      {riding && <Typography variant="body2">{t("alightAt", { place: leg.to.name })}</Typography>}
      {walkRepair && walkRepair !== "idle" && (
        <Typography variant="body2" role="status">
          {t(`transitWalkRepair.${walkRepair}`)}
        </Typography>
      )}
      {departurePassed && (
        <Typography variant="body2" color="warning.main" role="status">
          {t("departurePassed")}
        </Typography>
      )}
      {boardedNudge && <Typography variant="body2">{t("boardPrompt")}</Typography>}
      {alightNudge && <Typography variant="body2">{t("alightPrompt")}</Typography>}
      {uncertain && (
        <Typography variant="caption" role="status">
          {t(p?.confidence === "stale" ? "transitGpsStale" : "transitProgressUncertain")}
        </Typography>
      )}
      {p?.offPlan && <Alert severity="warning">{t("alightedElsewhere")}</Alert>}
      {!supported && <Alert severity="info">{t("transitActionsUpdateRequired")}</Alert>}
      {liveUnavailable && (
        <Typography variant="caption" role="status">
          {t("transitLiveUpdatesUnavailable")}
        </Typography>
      )}
      {failed && <Alert severity="error">{t("transitActionFailed")}</Alert>}
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        {riding && itinerary.legs[current + 1]?.interlineWithPrevious && (
          <Button disabled={pending || !supported} onClick={() => void run("continue")}>
            {t("stayOnBoard")}
          </Button>
        )}
        {!arrived && (riding || canBoard) && (
          <Button
            variant="contained"
            disabled={pending || !supported}
            onClick={() => void run(riding ? "alight" : "board")}
            sx={{ minHeight: 44, flex: "1 1 160px", minWidth: 0 }}
          >
            {t(riding ? "confirmAlight" : "confirmBoard")}
          </Button>
        )}
        {p?.canUndo && (!p.lastActionAtMs || now - p.lastActionAtMs <= 120000) && (
          <Button
            disabled={pending || !supported}
            onClick={() => void run("undo")}
            sx={{ minHeight: 44 }}
          >
            {t("undoTransitAction")}
          </Button>
        )}
        {!arrived && (
          <Button onClick={onAlternatives} disabled={pending} sx={{ minHeight: 44 }}>
            {t("findTransitAlternatives")}
          </Button>
        )}
      </Box>
    </Box>
  );
}
