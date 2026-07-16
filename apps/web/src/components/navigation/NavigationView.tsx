"use client";

import Box from "@mui/material/Box";
import Snackbar from "@mui/material/Snackbar";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  geoJsonBBox,
  isOverSpeed,
  laneGuidanceTriggerMeters,
  upcomingManeuverIndex,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useMapOptional } from "@/lib/MapContext";
import { useNavAlerts } from "@/lib/navigation/useNavAlerts";
import { useNavCamera } from "@/lib/navigation/useNavCamera";
import { useNavigationEngine } from "@/lib/navigation/useNavigationEngine";
import { useWakeLock } from "@/lib/useWakeLock";
import { AlertWidget } from "./AlertWidget";
import { ArrivalCard } from "./ArrivalCard";
import { LaneGuidance } from "./LaneGuidance";
import { ManeuverBanner } from "./ManeuverBanner";
import { NavBottomBar } from "./NavBottomBar";
import { NavBottomSheet } from "./NavBottomSheet";
import { NavSimControl } from "./NavSimControl";
import { RouteSearchControl } from "./RouteSearchControl";
import { SpeedLimitBadge } from "./SpeedLimitBadge";

export function NavigationView() {
  const status = useNavigationStore((s) => s.status);
  const kind = useNavigationStore((s) => s.kind);
  const mode = useNavigationStore((s) => s.mode);
  const route = useNavigationStore((s) => s.route);
  const progress = useNavigationStore((s) => s.progress);
  const weakGps = useNavigationStore((s) => s.weakGps);
  const rerouteFailedNonce = useNavigationStore((s) => s.rerouteFailedNonce);
  const currentSpeedLimit = useNavigationStore((s) => s.currentSpeedLimit);
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const toggleVoice = useNavigationStore((s) => s.toggleVoice);
  const toggleKeepScreenOn = useNavigationStore((s) => s.toggleKeepScreenOn);
  const setCameraMode = useNavigationStore((s) => s.setCameraMode);
  const stopNavigation = useNavigationStore((s) => s.stopNavigation);

  const mapCtx = useMapOptional();
  const units = useSettingsStore((s) => s.units);
  const t = useTranslations("navigation");
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  // Ground nav only; transit navigation is handled by TransitNavigationView.
  const active = status !== "idle" && kind === "ground";

  useNavigationEngine();
  useNavCamera();
  useWakeLock(active && keepScreenOn);
  const activeAlert = useNavAlerts();

  const [rerouteToastOpen, setRerouteToastOpen] = useState(false);
  useEffect(() => {
    if (rerouteFailedNonce > 0) setRerouteToastOpen(true);
  }, [rerouteFailedNonce]);

  if (!active) return null;

  const rerouting = status === "rerouting";

  // Show the nav chrome from the static route immediately on Start; live
  // position (progress) refines it once GPS fixes arrive. Without this, the
  // overlay is blank until the first fix — which never comes on devices that
  // deny or can't provide geolocation, so Start would appear to do nothing.
  const stepIndex = progress?.currentStepIndex ?? 0;
  // Surface the UPCOMING maneuver (at the end of the step you're driving), which
  // is what distanceToNextManeuver counts down to — not the one already done at
  // the start of the current step. `nextStep` is the one after that ("Then …").
  const upcomingIndex = route ? upcomingManeuverIndex(stepIndex, route.steps.length) : 0;
  const step = route ? route.steps[upcomingIndex] : null;
  const nextStep = route ? route.steps[upcomingIndex + 1] : undefined;
  const awaitingFix = status !== "arrived" && !progress;
  const distanceToManeuver = progress?.distanceToNextManeuver ?? step?.distance ?? 0;
  // Surface lanes near the maneuver, scaling the lead distance with speed so
  // motorway guidance appears earlier than urban guidance.
  const showLanes =
    !!step?.lanes && distanceToManeuver <= laneGuidanceTriggerMeters(mode, progress?.speedMps ?? 0);
  const distanceRemaining = progress?.distanceRemaining ?? route?.distance ?? 0;
  const durationRemaining = progress?.durationRemaining ?? route?.duration ?? 0;
  const etaEpochMs = progress?.etaEpochMs ?? Date.now() + durationRemaining * 1000;

  // Release the follow camera and frame the whole route. Used by the overflow
  // "overview" action; the recenter control flips the camera back to "follow".
  const handleOverview = () => {
    setCameraMode("free");
    const geometry = route?.geometry;
    if (!mapCtx || !geometry || geometry.length < 2) return;
    const box = geoJsonBBox({ type: "LineString", coordinates: geometry } as GeoJSON.LineString);
    if (!box) return;
    mapCtx.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      64,
    );
  };

  const navBar = route && (
    <NavBottomBar
      distanceRemaining={distanceRemaining}
      durationRemaining={durationRemaining}
      etaEpochMs={etaEpochMs}
      voiceEnabled={voiceEnabled}
      keepScreenOn={keepScreenOn}
      onToggleVoice={toggleVoice}
      onToggleKeepScreenOn={toggleKeepScreenOn}
      onOverview={handleOverview}
      onEnd={stopNavigation}
      units={units}
    />
  );

  return (
    <Box
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      <NavSimControl />
      {status === "arrived" ? (
        <Box
          sx={{ pointerEvents: "auto", m: "auto", bgcolor: "background.paper", borderRadius: 3 }}
        >
          <ArrivalCard onClose={stopNavigation} />
        </Box>
      ) : (
        <>
          <RouteSearchControl />
          <Box
            sx={{
              pointerEvents: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 1,
              p: 2,
              // Match the 16px (`p: 2`) side inset below the safe-area top so the
              // banner's gap to the top equals its gap to the sides.
              pt: "calc(var(--omx-safe-top) + 16px)",
            }}
          >
            {step && (
              <ManeuverBanner
                instruction={step.instruction}
                distanceToManeuver={distanceToManeuver}
                maneuver={step.maneuver}
                nextInstruction={nextStep?.instruction}
                nextManeuver={nextStep?.maneuver}
                units={units}
              />
            )}
            {showLanes && step?.lanes && (
              <LaneGuidance lanes={step.lanes} maneuver={step.maneuver} />
            )}
            {activeAlert && <AlertWidget alert={activeAlert} />}
            {rerouting && (
              <Box
                role="status"
                aria-live="polite"
                sx={{
                  alignSelf: "flex-start",
                  bgcolor: "warning.main",
                  color: "warning.contrastText",
                  borderRadius: 2,
                  px: 1.5,
                  py: 0.5,
                }}
              >
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  {t("rerouting")}
                </Typography>
              </Box>
            )}
            {(weakGps || awaitingFix) && (
              <Box
                role="status"
                aria-live="polite"
                sx={{
                  alignSelf: "flex-start",
                  bgcolor: "background.paper",
                  borderRadius: 2,
                  px: 1.5,
                  py: 0.5,
                }}
              >
                <Typography variant="caption" color="text.secondary">
                  {weakGps ? t("weakGps") : t("waitingForGps")}
                </Typography>
              </Box>
            )}
          </Box>

          {/* Bottom region: speed limit sits just above the panel, on the left. */}
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            {currentSpeedLimit !== null && (
              <Box sx={{ pointerEvents: "auto", alignSelf: "flex-start", pl: 2, pb: 1 }}>
                <SpeedLimitBadge
                  speedLimit={currentSpeedLimit}
                  units={units}
                  over={isOverSpeed(progress?.speedMps ?? 0, currentSpeedLimit)}
                />
              </Box>
            )}
            {navBar &&
              (isMobile ? (
                <NavBottomSheet>{navBar}</NavBottomSheet>
              ) : (
                <Box
                  sx={{
                    pointerEvents: "auto",
                    width: "100%",
                    maxWidth: 480,
                    mx: "auto",
                    mb: 2,
                    bgcolor: "background.paper",
                    borderRadius: 3,
                    boxShadow: 6,
                  }}
                >
                  {navBar}
                </Box>
              ))}
          </Box>
        </>
      )}
      <Snackbar
        open={rerouteToastOpen}
        autoHideDuration={4000}
        onClose={() => setRerouteToastOpen(false)}
        message={t("rerouteFailed")}
      />
    </Box>
  );
}
