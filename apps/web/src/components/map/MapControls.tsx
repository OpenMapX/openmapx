"use client";

import AddIcon from "@mui/icons-material/Add";
import ExploreIcon from "@mui/icons-material/Explore";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import RemoveIcon from "@mui/icons-material/Remove";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Tooltip from "@mui/material/Tooltip";
import { useMapStore, useNavigationStore, useSettingsStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useRef, useState } from "react";
import { useMyLocation } from "@/components/command-palette/useMyLocation";
import { useMap } from "@/integration-api/map/MapContext";
import { clearAlignAnnouncement, useAlignAnnouncement } from "@/lib/alignAnnouncement";
import { useMapObstructionInsets } from "@/lib/mapObstructions";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { useMobilePanelClearance, useWindowHeight } from "@/lib/mobilePanelHeight";
import { useAlignToStreets } from "@/lib/useAlignToStreets";
import { AlignToStreetsIcon, gridScreenTilt } from "./AlignToStreetsIcon";
import { resolveControlPlacement } from "./controlPlacement";
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
  const touchZoomButtons = useSettingsStore((s) => s.touchZoomButtons);
  const handleMyLocation = useMyLocation();
  const { axis: gridAxis, align } = useAlignToStreets();
  // The hook picks the words; this is simply the surface that shows them, for
  // every way of asking — the button below, or the command palette.
  const alignMessage = useAlignAnnouncement();
  const registry = useIntegrationRegistry();
  const crowdReportsEnabled = Boolean(registry.get("crowd-reports"));
  const vh = useWindowHeight();
  const { top: topInset } = useMapObstructionInsets();
  // Cap how far the controls follow the sheet — when the user drags above the
  // medium snap, the sheet covers the controls anyway, so freezing the offset
  // here keeps them in their last reachable position rather than scrolling
  // them off the top of the visible map area.
  const followHeight = useMobilePanelClearance(vh);
  const stackRef = useRef<HTMLDivElement>(null);
  const safeAreaRef = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState({ column: 0, grid: 0, safeBottom: 0 });
  const desiredBottom = followHeight > 0 ? followHeight + PANEL_GAP : BASE_BOTTOM;
  const placement =
    vh > 0 && heights.column > 0
      ? resolveControlPlacement(
          vh,
          topInset,
          desiredBottom,
          heights.column,
          heights.grid,
          heights.safeBottom,
        )
      : { columns: 1 as const, bottom: desiredBottom };

  useEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const measure = () => {
      // The zoom pair is hidden by a media query on touch screens, so it takes no space there.
      const zoomGroup = stack.querySelector<HTMLElement>("[data-map-zoom-group]");
      const zoomShown = !!zoomGroup && getComputedStyle(zoomGroup).display !== "none";
      const actions = Array.from(
        stack.querySelectorAll<HTMLElement>("button, [role='button']"),
      ).filter((action) => zoomShown || !zoomGroup?.contains(action));
      const sizes = actions.map((action) => action.getBoundingClientRect().height);
      if (sizes.length === 0 || sizes.some((size) => size <= 0)) return;
      // The zoom pair shares one Paper and a 1px divider instead of an 8px gap.
      const column =
        sizes.reduce((sum, size) => sum + size, 0) + (sizes.length - 1) * 8 - (zoomShown ? 7 : 0);
      let grid = 0;
      for (let i = 0; i < sizes.length; i += 2) {
        grid += Math.max(sizes[i], sizes[i + 1] ?? 0);
        if (i > 0) grid += 8;
      }
      const safeBottom = safeAreaRef.current?.getBoundingClientRect().height ?? 0;
      setHeights((previous) =>
        previous.column === column && previous.grid === grid && previous.safeBottom === safeBottom
          ? previous
          : { column, grid, safeBottom },
      );
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const observeActions = () => {
      resizeObserver?.disconnect();
      resizeObserver?.observe(stack);
      if (safeAreaRef.current) resizeObserver?.observe(safeAreaRef.current);
      for (const action of stack.querySelectorAll<HTMLElement>("button, [role='button']")) {
        resizeObserver?.observe(action);
      }
      measure();
    };
    const mutationObserver = new MutationObserver(observeActions);
    mutationObserver.observe(stack, { childList: true, subtree: true });
    observeActions();
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <>
      {crowdReportsEnabled && (
        <Suspense fallback={null}>
          <CrowdApproachPromptLazy />
          <ReportDialogLazy />
        </Suspense>
      )}
      <Box
        ref={stackRef}
        data-map-controls-columns={placement.columns}
        sx={{
          position: "absolute",
          // Bottom-anchored mobile sheets (browsing panels and the navigation
          // swipe sheet) register their live height in the shared registry, so
          // the controls always sit just above the tallest one — no hard-coded
          // per-context clearance.
          bottom: `calc(${placement.bottom}px + var(--omx-safe-bottom))`,
          right: "calc(12px + var(--omx-safe-right))",
          display: placement.columns === 2 ? "grid" : "flex",
          flexDirection: "column",
          gridTemplateColumns: placement.columns === 2 ? "repeat(2, max-content)" : undefined,
          alignItems: "center",
          gap: 1,
          zIndex: 10,
          transition: "bottom 0.25s ease",
          "@media (pointer: coarse)": {
            "& .MuiIconButton-root": { width: 44, height: 44 },
          },
          "& .MuiIconButton-root.Mui-focusVisible": {
            outline: "3px solid",
            outlineColor: "primary.main",
            outlineOffset: -3,
          },
        }}
      >
        <Box
          ref={safeAreaRef}
          data-map-safe-area-probe
          aria-hidden="true"
          sx={{
            position: "absolute",
            width: 0,
            height: "var(--omx-safe-bottom)",
            pointerEvents: "none",
          }}
        />
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

        {/* Zoom in / zoom out. Touch screens pinch and double-tap to zoom, so
          there the pair is hidden unless the user asks for it in Settings. A
          media query rather than a render check, so the server-rendered page
          doesn't flash the buttons before hydration. */}
        <Paper
          data-map-zoom-group
          elevation={2}
          sx={{
            borderRadius: "12px",
            overflow: "hidden",
            ...(placement.columns === 2 && {
              display: "contents",
              "& .MuiIconButton-root": {
                bgcolor: "background.paper",
                boxShadow: 2,
                borderRadius: "12px",
              },
              "& > .MuiBox-root": { display: "none" },
            }),
            ...(!touchZoomButtons && { "@media (pointer: coarse)": { display: "none" } }),
          }}
        >
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
        {gridAxis !== null && (
          <Tooltip title={t("alignToStreets")} placement="left">
            <Paper elevation={2} sx={{ borderRadius: "12px", overflow: "hidden" }}>
              <IconButton
                size="small"
                onClick={align}
                sx={{ width: 36, height: 36 }}
                aria-label={t("alignToStreetsAriaLabel")}
              >
                <AlignToStreetsIcon
                  tilt={gridScreenTilt(gridAxis, bearing)}
                  sx={{ fontSize: 20, color: "primary.main" }}
                />
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
        onClose={clearAlignAnnouncement}
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
