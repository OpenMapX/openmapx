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
import { geoJsonBBox, useNavigationStore, useSettingsStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { NavigationSettingsDialog } from "@/components/settings/NavigationSettingsDialog";
import { NAV_LANDSCAPE_PANEL_WIDTH } from "@/lib/layout";
import { useMapOptional } from "@/lib/MapContext";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { useMobilePanelClearance } from "@/lib/mobilePanelHeight";
import type { OfflineRouteCoverage } from "@/lib/navigation/offlineRouteCoverage";
import { ArrivalCard } from "./ArrivalCard";
import { FasterRouteBanner } from "./FasterRouteBanner";
import { NavAlertSlot } from "./NavAlertSlot";
import { NavBottomBarSlot } from "./NavBottomBarSlot";
import { NavDirectionsDialog } from "./NavDirectionsDialog";
import { NavManeuverSlot } from "./NavManeuverSlot";
import { NavMenu } from "./NavMenu";
import { NavOfflineBannerSlot } from "./NavOfflineBannerSlot";
import { NavPerfControl } from "./NavPerfControl";
import { NavSimControl } from "./NavSimControl";
import { NavSpeedLimitSlot } from "./NavSpeedLimitSlot";
import { NavStatusSlot } from "./NavStatusSlot";
import { NavSwipeSheet } from "./NavSwipeSheet";
import { RouteSearchControl } from "./RouteSearchControl";

interface Props {
  coverage: OfflineRouteCoverage;
}

/**
 * Builds the ground-navigation chrome's structure — layout, the menu/dialog
 * state machine, the arrived/live branch — without ever reading `progress`
 * itself. Every value that changes on a GPS fix lives in one of the hot slots
 * this renders (`NavManeuverSlot`, `NavBottomBarSlot`, `NavSpeedLimitSlot`,
 * `NavAlertSlot`, `NavStatusSlot`), so an accepted fix re-renders only those,
 * not this component or the controls (`RouteSearchControl`, `NavMenu`, the
 * dialogs) it owns.
 */
export function GroundNavigationChrome({ coverage }: Props) {
  const route = useNavigationStore((s) => s.route);
  const status = useNavigationStore((s) => s.status);
  const rerouteFailedNonce = useNavigationStore((s) => s.rerouteFailedNonce);
  const setCameraMode = useNavigationStore((s) => s.setCameraMode);
  const { completeArrival } = useNavigationMutations();
  const units = useSettingsStore((s) => s.units);

  const mapCtx = useMapOptional();
  const t = useTranslations("navigation");
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));

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

  const rerouting = status === "rerouting";

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
      {/* Both self-gate on their URL flag and render nothing in normal use. */}
      <NavPerfControl />
      {status === "arrived" ? (
        <Box
          sx={{ pointerEvents: "auto", m: "auto", bgcolor: "background.paper", borderRadius: 3 }}
        >
          <ArrivalCard onClose={() => void completeArrival()} />
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
            <NavManeuverSlot />
            <NavOfflineBannerSlot coverage={coverage} />
            <NavAlertSlot />
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
            <NavStatusSlot />
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
            <NavSpeedLimitSlot isMobile={isMobile} sheetClearance={sheetClearance} />
            {route &&
              (isMobile ? (
                <NavSwipeSheet
                  expanded={menuOpen}
                  onExpandedChange={setMenuOpen}
                  header={<NavBottomBarSlot />}
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
                    <NavBottomBarSlot menuToggle={desktopMenuToggle} />
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
