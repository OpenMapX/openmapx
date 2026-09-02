"use client";

import AddIcon from "@mui/icons-material/Add";
import ExploreIcon from "@mui/icons-material/Explore";
import Grid4x4Icon from "@mui/icons-material/Grid4x4";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import RemoveIcon from "@mui/icons-material/Remove";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Tooltip from "@mui/material/Tooltip";
import { useMapStore, useNavigationStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { Suspense, useState } from "react";
import { useMyLocation } from "@/components/command-palette/useMyLocation";
import { useMap } from "@/integration-api/map/MapContext";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { useMobilePanelClearance, useWindowHeight } from "@/lib/mobilePanelHeight";
import { useAlignToStreets } from "@/lib/useAlignToStreets";
import { CrowdApproachPromptLazy, ReportDialogLazy, ReportFabLazy } from "./crowdReportsLazy";
import { Pegman } from "./Pegman";

const BASE_BOTTOM = 48;
const PANEL_GAP = 12;

/** Off-screen but readable by assistive technology. `sx` treats a bare 1 as 100%, so the sizes are explicit. */
const SR_ONLY = {
  border: 0,
  clip: "rect(0 0 0 0)",
  height: "1px",
  margin: "-1px",
  overflow: "hidden",
  padding: 0,
  position: "absolute",
  whiteSpace: "nowrap",
  width: "1px",
} as const;

export function MapControls() {
  const t = useTranslations("map");
  const tNav = useTranslations("navigation");
  const { zoomIn, zoomOut, resetBearing } = useMap();
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const navKind = useNavigationStore((s) => s.kind);
  const navCameraMode = useNavigationStore((s) => s.cameraMode);
  const setCameraMode = useNavigationStore((s) => s.setCameraMode);
  // Voice guidance toggle rides this stack during navigation (both ground
  // maneuvers and transit board/alight/alert cues); its counterpart,
  // search-along-route, sits in the ground nav bottom bar.
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const { toggleVoice } = useNavigationMutations();
  const showVoiceButton = navigating && (navKind === "ground" || navKind === "transit");
  const bearing = useMapStore((s) => s.bearing);
  const pitch = useMapStore((s) => s.pitch);
  const handleMyLocation = useMyLocation();
  const { available: alignAvailable, align } = useAlignToStreets();
  const [alignMessage, setAlignMessage] = useState<{ text: string; seq: number } | null>(null);
  // The counter makes a repeat of the same words a new value: asking twice has
  // to re-announce and restart the toast, and identical state would do neither.
  const showAlignMessage = (text: string) =>
    setAlignMessage((previous) => ({ text, seq: (previous?.seq ?? 0) + 1 }));
  // A refusal is the interesting outcome: a rotation is self-evident on screen,
  // but nothing moving needs a reason.
  const handleAlign = () => {
    const status = align();
    if (status === "no-grid") showAlignMessage(t("alignNoGrid"));
    else if (status === "zoomed-out") showAlignMessage(t("alignZoomIn"));
    else if (status === "aligned") showAlignMessage(t("alignAlready"));
  };
  const registry = useIntegrationRegistry();
  const crowdReportsEnabled = Boolean(registry.get("crowd-reports"));
  const vh = useWindowHeight();
  // Cap how far the controls follow the sheet — when the user drags above the
  // medium snap, the sheet covers the controls anyway, so freezing the offset
  // here keeps them in their last reachable position rather than scrolling
  // them off the top of the visible map area.
  const followHeight = useMobilePanelClearance(vh);

  return (
    <>
      {crowdReportsEnabled && (
        <Suspense fallback={null}>
          <CrowdApproachPromptLazy />
          <ReportDialogLazy />
        </Suspense>
      )}
      <Box
        sx={{
          position: "absolute",
          // Bottom-anchored mobile sheets (browsing panels and the navigation
          // swipe sheet) register their live height in the shared registry, so
          // the controls always sit just above the tallest one — no hard-coded
          // per-context clearance.
          bottom: {
            xs:
              followHeight > 0
                ? `calc(${followHeight + PANEL_GAP}px + var(--omx-safe-bottom))`
                : `calc(${BASE_BOTTOM}px + var(--omx-safe-bottom))`,
            sm: `calc(${BASE_BOTTOM}px + var(--omx-safe-bottom))`,
          },
          right: "calc(12px + var(--omx-safe-right))",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 1,
          zIndex: 10,
          transition: "bottom 0.25s ease",
        }}
      >
        {/* Voice guidance toggle (ground navigation only) — top of the stack. */}
        {showVoiceButton && (
          <Tooltip title={tNav(voiceEnabled ? "muteVoice" : "unmuteVoice")} placement="left">
            <Paper elevation={2} sx={{ borderRadius: "12px", overflow: "hidden" }}>
              <IconButton
                size="small"
                onClick={() => void toggleVoice()}
                sx={{ width: 36, height: 36 }}
                aria-label={tNav(voiceEnabled ? "muteVoice" : "unmuteVoice")}
              >
                {voiceEnabled ? (
                  <VolumeUpIcon sx={{ fontSize: 18, color: "primary.main" }} />
                ) : (
                  <VolumeOffIcon sx={{ fontSize: 18, color: "primary.main" }} />
                )}
              </IconButton>
            </Paper>
          </Tooltip>
        )}

        {/* Report a condition (crowd-reports) */}
        {crowdReportsEnabled && (
          <Suspense fallback={null}>
            <ReportFabLazy />
          </Suspense>
        )}

        {/* My location — redundant while navigating (the follow camera and the
          recenter compass already handle it); only useful for recentering while
          browsing the map. */}
        {!navigating && (
          <Tooltip title={t("myLocation")} placement="left">
            <Paper elevation={2} sx={{ borderRadius: "12px", overflow: "hidden" }}>
              <IconButton
                size="small"
                onClick={handleMyLocation}
                sx={{ width: 36, height: 36 }}
                aria-label={t("goToMyLocationAriaLabel")}
              >
                <MyLocationIcon sx={{ fontSize: 18, color: "primary.main" }} />
              </IconButton>
            </Paper>
          </Tooltip>
        )}

        {/* Zoom in / zoom out */}
        <Paper elevation={2} sx={{ borderRadius: "12px", overflow: "hidden" }}>
          <Tooltip title={t("zoomIn")} placement="left">
            <IconButton
              size="small"
              onClick={zoomIn}
              sx={{ width: 36, height: 36, borderRadius: 0 }}
              aria-label={t("zoomInAriaLabel")}
            >
              <AddIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Box sx={{ height: "1px", bgcolor: "divider", mx: 1 }} />
          <Tooltip title={t("zoomOut")} placement="left">
            <IconButton
              size="small"
              onClick={zoomOut}
              sx={{ width: 36, height: 36, borderRadius: 0 }}
              aria-label={t("zoomOutAriaLabel")}
            >
              <RemoveIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Paper>

        {/* Street-level imagery pegman is irrelevant during turn-by-turn navigation. */}
        {!navigating && <Pegman />}

        {/* Align to the local street grid — offered only where the hook can act
          on it (a live map, not navigating, zoomed in far enough). */}
        {alignAvailable && (
          <Tooltip title={t("alignToStreets")} placement="left">
            <Paper elevation={2} sx={{ borderRadius: "12px", overflow: "hidden" }}>
              <IconButton
                size="small"
                onClick={handleAlign}
                sx={{ width: 36, height: 36 }}
                aria-label={t("alignToStreetsAriaLabel")}
              >
                <Grid4x4Icon sx={{ fontSize: 18, color: "primary.main" }} />
              </IconButton>
            </Paper>
          </Tooltip>
        )}

        {/* Compass — while navigating it appears whenever the camera has left
          follow (a pan off-track, or the route overview) and recenters/resumes
          tracking; otherwise it resets bearing and is only visible when the map
          is rotated. */}
        {(navigating ? navCameraMode !== "follow" : Math.abs(bearing) > 0.5 || pitch > 0.5) && (
          <Tooltip title={navigating ? tNav("recenter") : t("resetBearing")} placement="left">
            <Paper elevation={2} sx={{ borderRadius: "50%", overflow: "hidden" }}>
              <IconButton
                size="medium"
                onClick={navigating ? () => setCameraMode("follow") : resetBearing}
                sx={{ width: 40, height: 40 }}
                aria-label={navigating ? tNav("recenter") : t("resetBearingAriaLabel")}
              >
                <ExploreIcon
                  sx={{
                    transform: `rotate(${-bearing}deg)`,
                    transition: "transform 0.2s",
                    color: "error.main",
                    fontSize: 22,
                  }}
                />
              </IconButton>
            </Paper>
          </Tooltip>
        )}
      </Box>

      {/* The snackbar carries the refusal to the eye; the live region below
        carries it to screen readers, so the snackbar itself stays silent. */}
      <Snackbar
        key={alignMessage?.seq}
        open={alignMessage !== null}
        autoHideDuration={2500}
        onClose={() => setAlignMessage(null)}
        message={alignMessage?.text}
        slotProps={{ content: { role: "presentation" } }}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
      {/* The region itself stays mounted — screen readers ignore one that
        appears with its text already in place — and only the child is swapped. */}
      <Box role="status" aria-live="polite" sx={SR_ONLY}>
        <span key={alignMessage?.seq}>{alignMessage?.text}</span>
      </Box>
    </>
  );
}
