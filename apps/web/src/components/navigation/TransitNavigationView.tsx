"use client";

import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { geoJsonBBox, useNavigationStore, useSettingsStore, useSidebarStore } from "@openmapx/core";
import { nextTransferFor } from "@openmapx/core/navigation";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { NavigationSettingsDialog } from "@/components/settings/NavigationSettingsDialog";
import { NAV_LANDSCAPE_PANEL_WIDTH } from "@/lib/layout";
import { useMapOptional } from "@/lib/MapContext";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { useTransitLiveRefresh } from "@/lib/navigation/useTransitLiveRefresh";
import { useTransitNavigationEngine } from "@/lib/navigation/useTransitNavigationEngine";
import { useWakeLock } from "@/lib/useWakeLock";
import { NavSwipeSheet } from "./NavSwipeSheet";
import { TransitAlertBanner } from "./TransitAlertBanner";
import { TransitArrivalCard } from "./TransitArrivalCard";
import { TransitConnectionRisk } from "./TransitConnectionRisk";
import { TransitJourneySheet } from "./TransitJourneySheet";
import { TransitLegBanner } from "./TransitLegBanner";
import { TransitNavBottomBar } from "./TransitNavBottomBar";
import { TransitNavMenu } from "./TransitNavMenu";
import { TransitWalkBanner } from "./TransitWalkBanner";

export function TransitNavigationView() {
  const status = useNavigationStore((s) => s.status);
  const kind = useNavigationStore((s) => s.kind);
  const itinerary = useNavigationStore((s) => s.itinerary);
  const transitProgress = useNavigationStore((s) => s.transitProgress);
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const setCameraMode = useNavigationStore((s) => s.setCameraMode);
  const { completeArrival } = useNavigationMutations();
  const units = useSettingsStore((s) => s.units);

  const mapCtx = useMapOptional();
  const t = useTranslations("navigation");
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const active = status !== "idle" && status !== "arrived" && kind === "transit";
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Hooks must run before any early return.
  useTransitNavigationEngine();
  useTransitLiveRefresh(active);
  useWakeLock(active && keepScreenOn);

  // Collapse the route-planning sidebar while navigating; restore on exit.
  useEffect(() => {
    if (!active) return;
    const prevCollapsed = useSidebarStore.getState().collapsed;
    useSidebarStore.getState().setCollapsed(true);
    return () => useSidebarStore.getState().setCollapsed(prevCollapsed);
  }, [active]);

  if (status === "idle" || kind !== "transit" || !itinerary) return null;

  const legs = itinerary.legs;
  const currentLegIndex = Math.min(transitProgress?.currentLegIndex ?? 0, legs.length - 1);
  const currentLeg = legs[currentLegIndex] as TripLeg | undefined;
  const transfer = nextTransferFor(legs, currentLegIndex);
  // A walk leg with step-level directions gets turn-by-turn guidance; other legs
  // (and detail-less walks) use the standard leg banner.
  const isGuidedWalk =
    !!currentLeg &&
    currentLeg.mode === "walking" &&
    !!currentLeg.steps &&
    currentLeg.steps.length > 0;

  // Release the follow camera and frame the whole itinerary. The MapControls
  // recenter compass (shown while cameraMode === "free") resumes following.
  const handleOverview = () => {
    setCameraMode("free");
    const coords = legs.flatMap((l) => l.geometry?.coordinates ?? []);
    if (!mapCtx || coords.length < 2) return;
    const box = geoJsonBBox({ type: "LineString", coordinates: coords } as GeoJSON.LineString);
    if (!box) return;
    mapCtx.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      64,
    );
  };

  const menu = (
    <TransitNavMenu onOverview={handleOverview} onOpenSettings={() => setSettingsOpen(true)} />
  );
  // Desktop reveals the menu with a chevron; mobile drags the sheet up.
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
      {status === "arrived" ? (
        <Box
          sx={{ pointerEvents: "auto", m: "auto", bgcolor: "background.paper", borderRadius: 3 }}
        >
          <TransitArrivalCard itinerary={itinerary} onClose={() => void completeArrival()} />
        </Box>
      ) : (
        <>
          <Box
            sx={{
              pointerEvents: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 1,
              p: 2,
              // Match the driving banner's inset below the safe-area top so the
              // gap to the top equals the gap to the sides.
              pt: "calc(var(--omx-safe-top) + 16px)",
              // On wide screens keep the chrome in a left-hand column (like the
              // driving view) so the map stays clear on the right.
              ...(isMobile
                ? {}
                : {
                    alignSelf: "flex-start",
                    width: 1,
                    maxWidth: NAV_LANDSCAPE_PANEL_WIDTH + 32,
                    // Never let the always-on instruction banner shrink; only the
                    // expandable panel below gives up space when the column is short.
                    flexShrink: 0,
                  }),
            }}
          >
            {currentLeg &&
              (isGuidedWalk ? (
                <TransitWalkBanner
                  leg={currentLeg}
                  transitProgress={transitProgress}
                  units={units}
                />
              ) : (
                <TransitLegBanner
                  leg={currentLeg}
                  legIndex={currentLegIndex}
                  totalLegs={legs.length}
                  transitProgress={transitProgress}
                  transfer={transfer}
                />
              ))}
            <TransitAlertBanner
              itinerary={itinerary}
              currentLegIndex={currentLegIndex}
              transitProgress={transitProgress}
            />
            {currentLeg?.route && transfer && (
              <TransitConnectionRisk leg={currentLeg} transfer={transfer} />
            )}
          </Box>

          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              // Desktop: allow this block to give up height so the panel below
              // caps to the space left under the (non-shrinking) banner and
              // scrolls instead of running off the bottom of the viewport.
              ...(isMobile ? {} : { minHeight: 0 }),
            }}
          >
            {isMobile ? (
              <NavSwipeSheet
                expanded={sheetOpen}
                onExpandedChange={setSheetOpen}
                header={<TransitNavBottomBar itinerary={itinerary} currentLeg={currentLeg} />}
              >
                <TransitJourneySheet
                  itinerary={itinerary}
                  currentLegIndex={currentLegIndex}
                  transitProgress={transitProgress}
                />
                {menu}
              </NavSwipeSheet>
            ) : (
              <Box
                sx={{
                  pointerEvents: "auto",
                  width: "100%",
                  maxWidth: NAV_LANDSCAPE_PANEL_WIDTH,
                  // Left-aligned (16px in, matching the banner) rather than
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
                  <TransitNavBottomBar
                    itinerary={itinerary}
                    currentLeg={currentLeg}
                    menuToggle={desktopMenuToggle}
                  />
                </Box>
                {/* Header stays pinned; the expanded journey + menu scroll. */}
                <Box sx={{ minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
                  <Collapse in={menuOpen} unmountOnExit>
                    <TransitJourneySheet
                      itinerary={itinerary}
                      currentLegIndex={currentLegIndex}
                      transitProgress={transitProgress}
                      scroll={false}
                    />
                    {menu}
                  </Collapse>
                </Box>
              </Box>
            )}
          </Box>
        </>
      )}
      <NavigationSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Box>
  );
}
