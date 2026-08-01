"use client";

import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import Snackbar from "@mui/material/Snackbar";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  geoJsonBBox,
  guidanceApproachMeters,
  isOverSpeed,
  shouldPreviewNextStep,
  upcomingManeuverIndex,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { NavigationSettingsDialog } from "@/components/settings/NavigationSettingsDialog";
import { NAV_LANDSCAPE_PANEL_WIDTH } from "@/lib/layout";
import { useMapOptional } from "@/lib/MapContext";
import { useMobilePanelClearance } from "@/lib/mobilePanelHeight";
import { useRouteSearchStore } from "@/lib/navigation/routeSearchStore";
import { useNavAlerts } from "@/lib/navigation/useNavAlerts";
import { useNavCamera } from "@/lib/navigation/useNavCamera";
import { useNavigationEngine } from "@/lib/navigation/useNavigationEngine";
import { useWakeLock } from "@/lib/useWakeLock";
import { AlertWidget } from "./AlertWidget";
import { ArrivalCard } from "./ArrivalCard";
import { FasterRouteBanner } from "./FasterRouteBanner";
import { ManeuverBanner } from "./ManeuverBanner";
import { NavBottomBar } from "./NavBottomBar";
import { NavDirectionsDialog } from "./NavDirectionsDialog";
import { NavMenu } from "./NavMenu";
import { NavSimControl } from "./NavSimControl";
import { NavSwipeSheet } from "./NavSwipeSheet";
import { RouteSearchControl } from "./RouteSearchControl";
import { SpeedLimitBadge } from "./SpeedLimitBadge";

export function NavigationView() {
  const status = useNavigationStore((s) => s.status);
  const kind = useNavigationStore((s) => s.kind);
  const mode = useNavigationStore((s) => s.mode);
  const route = useNavigationStore((s) => s.route);
  const progress = useNavigationStore((s) => s.progress);
  const weakGps = useNavigationStore((s) => s.weakGps);
  const coasting = useNavigationStore((s) => s.coasting);
  const rerouteFailedNonce = useNavigationStore((s) => s.rerouteFailedNonce);
  const currentSpeedLimit = useNavigationStore((s) => s.currentSpeedLimit);
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const setCameraMode = useNavigationStore((s) => s.setCameraMode);
  const stopNavigation = useNavigationStore((s) => s.stopNavigation);
  const openRouteSearch = useRouteSearchStore((s) => s.openPicker);
  const routeSearchOpen = useRouteSearchStore((s) => s.open);

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [directionsOpen, setDirectionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (rerouteFailedNonce > 0) setRerouteToastOpen(true);
  }, [rerouteFailedNonce]);

  // The mobile sheet is a fixed-position host (it lives above the map, not in
  // this column's flow), so nothing here reserves space for it any more —
  // lift the speed limit badge by its live height, the same way MapControls
  // and LegendHost lift the map's own bottom-anchored chrome.
  const [vh, setVh] = useState(0);
  useEffect(() => {
    const update = () => setVh(window.innerHeight);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const sheetClearance = useMobilePanelClearance(vh);

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
  const speedMps = progress?.speedMps ?? 0;
  // Detailed guidance becomes relevant only inside the approach window (a lead
  // time before the maneuver that stretches on the motorway) — so on a long
  // stretch neither the lanes nor the "Then …" preview clutter the banner.
  const approaching = distanceToManeuver <= guidanceApproachMeters(mode, speedMps);
  const showLanes = !!step?.lanes && approaching;
  // Preview the maneuver after this one only when it's both relevant (approaching)
  // and follows closely (a short gap), so back-to-back turns chain but far-apart
  // ones don't.
  const showNextStep =
    !!nextStep &&
    shouldPreviewNextStep(mode, speedMps, distanceToManeuver, nextStep.duration, nextStep.distance);
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

  const navMenu = (
    <NavMenu
      // Directions/Settings open a full-screen dialog over the sheet; leave the
      // sheet expanded (don't collapse) so returning shows the menu correctly.
      // Collapsing while the dialog mounts corrupts the sheet's measured height.
      onOpenDirections={() => setDirectionsOpen(true)}
      onOpenSettings={() => setSettingsOpen(true)}
      // Overview reveals the map, so collapse the sheet (no dialog to interfere).
      onOverview={() => {
        setMenuOpen(false);
        handleOverview();
      }}
    />
  );
  // Desktop reveals the menu with a chevron (no swipe); mobile drags the sheet.
  const desktopMenuToggle = (
    <IconButton
      onClick={() => setMenuOpen((o) => !o)}
      aria-label={t("moreOptions")}
      aria-expanded={menuOpen}
    >
      {menuOpen ? <ExpandMoreIcon /> : <ExpandLessIcon />}
    </IconButton>
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
              // On wide screens keep the banner in a left-hand column instead of
              // stretching across the whole top edge (maxWidth adds back the 16px
              // horizontal padding so the card itself is LANDSCAPE_PANEL_WIDTH).
              ...(isMobile
                ? {}
                : {
                    alignSelf: "flex-start",
                    width: 1,
                    maxWidth: NAV_LANDSCAPE_PANEL_WIDTH + 32,
                    // Keep the maneuver banner fully visible; only the panel below
                    // gives up space when the column is short.
                    flexShrink: 0,
                  }),
            }}
          >
            {step && (
              <ManeuverBanner
                instruction={step.instruction}
                distanceToManeuver={distanceToManeuver}
                maneuver={step.maneuver}
                nextInstruction={showNextStep ? nextStep?.instruction : undefined}
                nextManeuver={showNextStep ? nextStep?.maneuver : undefined}
                lanes={showLanes ? step.lanes : undefined}
                units={units}
              />
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
            <FasterRouteBanner />
            {(coasting || weakGps || awaitingFix) && (
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
                  {coasting ? t("estimatedPosition") : weakGps ? t("weakGps") : t("waitingForGps")}
                </Typography>
              </Box>
            )}
          </Box>

          {/* Bottom region: speed limit sits just above the panel, on the left. */}
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              // Desktop: let this block shrink so the panel caps under the
              // (non-shrinking) banner and scrolls rather than overflowing.
              ...(isMobile ? {} : { minHeight: 0 }),
            }}
          >
            {currentSpeedLimit !== null && (
              <Box
                sx={{
                  pointerEvents: "auto",
                  alignSelf: "flex-start",
                  pl: 2,
                  pb: 1,
                  // Lifts the badge above the fixed-position mobile sheet;
                  // inert on desktop, where the panel stays in-flow below it
                  // and the sheet (so this clearance) never mounts.
                  mb: isMobile && sheetClearance > 0 ? `${sheetClearance}px` : 0,
                }}
              >
                <SpeedLimitBadge
                  speedLimit={currentSpeedLimit}
                  units={units}
                  over={isOverSpeed(progress?.speedMps ?? 0, currentSpeedLimit)}
                />
              </Box>
            )}
            {route &&
              (isMobile ? (
                <NavSwipeSheet
                  expanded={menuOpen}
                  onExpandedChange={setMenuOpen}
                  header={
                    <NavBottomBar
                      distanceRemaining={distanceRemaining}
                      durationRemaining={durationRemaining}
                      etaEpochMs={etaEpochMs}
                      onSearch={routeSearchOpen ? undefined : openRouteSearch}
                      onEnd={stopNavigation}
                      units={units}
                    />
                  }
                >
                  {navMenu}
                </NavSwipeSheet>
              ) : (
                <Box
                  sx={{
                    pointerEvents: "auto",
                    width: "100%",
                    maxWidth: NAV_LANDSCAPE_PANEL_WIDTH,
                    // Left-aligned (16px in, matching the top banner) rather than
                    // centered, so the map stays clear on the right.
                    ml: 2,
                    mb: 2,
                    bgcolor: "background.paper",
                    borderRadius: 3,
                    boxShadow: 6,
                    // Flex column: the header stays put and the panel shrinks to
                    // the height the (shrinkable) column leaves it, so the menu
                    // scrolls instead of overflowing the viewport.
                    display: "flex",
                    flexDirection: "column",
                    minHeight: 0,
                    overflow: "hidden",
                  }}
                >
                  <Box sx={{ flexShrink: 0 }}>
                    <NavBottomBar
                      distanceRemaining={distanceRemaining}
                      durationRemaining={durationRemaining}
                      etaEpochMs={etaEpochMs}
                      onSearch={routeSearchOpen ? undefined : openRouteSearch}
                      onEnd={stopNavigation}
                      units={units}
                      menuToggle={desktopMenuToggle}
                    />
                  </Box>
                  {/* Header stays pinned; the expanded menu scrolls. */}
                  <Box sx={{ minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
                    <Collapse in={menuOpen} unmountOnExit>
                      {navMenu}
                    </Collapse>
                  </Box>
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
      {route && (
        <NavDirectionsDialog
          open={directionsOpen}
          onClose={() => setDirectionsOpen(false)}
          route={route}
          units={units}
        />
      )}
      <NavigationSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Box>
  );
}
