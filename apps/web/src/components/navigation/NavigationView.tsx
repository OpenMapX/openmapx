"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useNavigationStore, useSidebarStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useMapOptional } from "@/lib/MapContext";
import { useFollowCamera } from "@/lib/navigation/useFollowCamera";
import { useNavigationEngine } from "@/lib/navigation/useNavigationEngine";
import { useHeading } from "@/lib/useHeading";
import { useWakeLock } from "@/lib/useWakeLock";
import { ArrivalCard } from "./ArrivalCard";
import { LaneGuidance } from "./LaneGuidance";
import { ManeuverBanner } from "./ManeuverBanner";
import { NavBottomBar } from "./NavBottomBar";
import { NavHeadingPuck } from "./NavHeadingPuck";
import { RecenterFab } from "./RecenterFab";
import { SpeedLimitBadge } from "./SpeedLimitBadge";

export function NavigationView() {
  const map = useMapOptional()?.mapRef.current ?? null;
  const status = useNavigationStore((s) => s.status);
  const route = useNavigationStore((s) => s.route);
  const progress = useNavigationStore((s) => s.progress);
  const cameraMode = useNavigationStore((s) => s.cameraMode);
  const currentSpeedLimit = useNavigationStore((s) => s.currentSpeedLimit);
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const setCameraMode = useNavigationStore((s) => s.setCameraMode);
  const toggleVoice = useNavigationStore((s) => s.toggleVoice);
  const stopNavigation = useNavigationStore((s) => s.stopNavigation);

  const [units] = useState<"metric" | "imperial">("metric");
  const t = useTranslations("navigation");
  const active = status !== "idle";

  useNavigationEngine();
  useFollowCamera(map);
  useWakeLock(active && keepScreenOn);
  const heading = useHeading(active);

  // Collapse the route-planning sidebar while navigating so it doesn't sit on
  // top of the map behind the nav overlay; restore the prior state on exit.
  useEffect(() => {
    if (!active) return;
    const prevCollapsed = useSidebarStore.getState().collapsed;
    useSidebarStore.getState().setCollapsed(true);
    return () => useSidebarStore.getState().setCollapsed(prevCollapsed);
  }, [active]);

  if (!active) return null;

  // Show the nav chrome from the static route immediately on Start; live
  // position (progress) refines it once GPS fixes arrive. Without this, the
  // overlay is blank until the first fix — which never comes on devices that
  // deny or can't provide geolocation, so Start would appear to do nothing.
  const step = route ? route.steps[progress?.currentStepIndex ?? 0] : null;
  const awaitingFix = status !== "arrived" && !progress;
  const distanceToManeuver = progress?.distanceToNextManeuver ?? step?.distance ?? 0;
  const distanceRemaining = progress?.distanceRemaining ?? route?.distance ?? 0;
  const durationRemaining = progress?.durationRemaining ?? route?.duration ?? 0;
  const etaEpochMs = progress?.etaEpochMs ?? Date.now() + durationRemaining * 1000;

  return (
    <>
      <NavHeadingPuck heading={heading} />
      <Box
        sx={{
          position: "fixed",
          inset: 0,
          zIndex: 1300,
          pointerEvents: "none",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          p: 2,
          pt: "calc(var(--omx-safe-top) + 8px)",
          pb: "calc(var(--omx-safe-bottom) + 8px)",
        }}
      >
        {status === "arrived" ? (
          <Box
            sx={{ pointerEvents: "auto", m: "auto", bgcolor: "background.paper", borderRadius: 3 }}
          >
            <ArrivalCard onClose={stopNavigation} />
          </Box>
        ) : (
          <>
            <Box sx={{ pointerEvents: "auto", display: "flex", flexDirection: "column", gap: 1 }}>
              {step && (
                <ManeuverBanner
                  instruction={step.instruction}
                  distanceToManeuver={distanceToManeuver}
                  maneuver={step.maneuver}
                  units={units}
                />
              )}
              {step?.lanes && <LaneGuidance lanes={step.lanes} />}
              {awaitingFix && (
                <Box
                  sx={{
                    alignSelf: "flex-start",
                    bgcolor: "background.paper",
                    borderRadius: 2,
                    px: 1.5,
                    py: 0.5,
                  }}
                >
                  <Typography variant="caption" color="text.secondary">
                    {t("waitingForGps")}
                  </Typography>
                </Box>
              )}
            </Box>

            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
              <Box sx={{ pointerEvents: "auto" }}>
                <SpeedLimitBadge speedLimit={currentSpeedLimit} units={units} />
              </Box>
              {cameraMode === "free" && (
                <Box sx={{ pointerEvents: "auto" }}>
                  <RecenterFab onClick={() => setCameraMode("follow")} />
                </Box>
              )}
            </Box>

            {route && (
              <Box sx={{ pointerEvents: "auto", mb: 5 }}>
                <NavBottomBar
                  distanceRemaining={distanceRemaining}
                  durationRemaining={durationRemaining}
                  etaEpochMs={etaEpochMs}
                  voiceEnabled={voiceEnabled}
                  onToggleVoice={toggleVoice}
                  onEnd={stopNavigation}
                  units={units}
                />
              </Box>
            )}
          </>
        )}
      </Box>
    </>
  );
}
