"use client";

import Box from "@mui/material/Box";
import { useNavigationStore } from "@openmapx/core";
import { useState } from "react";
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
  const active = status !== "idle";

  useNavigationEngine();
  useFollowCamera(map);
  useWakeLock(active && keepScreenOn);
  const heading = useHeading(active);

  if (!active) return null;

  const step = route && progress ? route.steps[progress.currentStepIndex] : null;

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
              {step && progress && (
                <ManeuverBanner
                  instruction={step.instruction}
                  distanceToManeuver={progress.distanceToNextManeuver}
                  maneuver={step.maneuver}
                  units={units}
                />
              )}
              {step?.lanes && <LaneGuidance lanes={step.lanes} />}
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

            {progress && (
              <Box sx={{ pointerEvents: "auto" }}>
                <NavBottomBar
                  distanceRemaining={progress.distanceRemaining}
                  durationRemaining={progress.durationRemaining}
                  etaEpochMs={progress.etaEpochMs}
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
