"use client";

import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { geoJsonBBox, useNavigationStore, useSettingsStore, useSidebarStore } from "@openmapx/core";
import { nextTransferFor } from "@openmapx/core/navigation";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useEffect, useState } from "react";
import { NavigationSettingsDialog } from "@/components/settings/NavigationSettingsDialog";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { NAV_CHROME_TOP, NAV_LANDSCAPE_PANEL_WIDTH } from "@/lib/layout";
import { useMapObstructionExtent } from "@/lib/mapObstructions";
import { useMobileRuntime } from "@/lib/mobile/useMobileRuntime";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { useNavChromeObstructions } from "@/lib/navigation/useNavChromeObstructions";
import { useTransitFollowCamera } from "@/lib/navigation/useTransitFollowCamera";
import { useTransitLiveRefresh } from "@/lib/navigation/useTransitLiveRefresh";
import { useTransitNavigationEngine } from "@/lib/navigation/useTransitNavigationEngine";
import { useTransitWalkRepair } from "@/lib/navigation/useTransitWalkRepair";
import { useWakeLock } from "@/lib/useWakeLock";
import { NavSwipeSheet } from "./NavSwipeSheet";
import { TransitAlertBanner } from "./TransitAlertBanner";
import { TransitAlternativesDialog } from "./TransitAlternativesDialog";
import { TransitArrivalCard } from "./TransitArrivalCard";
import { TransitConnectionRisk } from "./TransitConnectionRisk";
import { TransitGuidanceCues } from "./TransitGuidanceCues";
import { TransitJourneyControls } from "./TransitJourneyControls";
import { TransitJourneySheet } from "./TransitJourneySheet";
import { TransitJourneyToolbar } from "./TransitJourneyToolbar";
import { TransitLegBanner } from "./TransitLegBanner";
import { TransitNavBottomBar } from "./TransitNavBottomBar";
import { TransitNavMenu } from "./TransitNavMenu";
import { TransitWalkBanner } from "./TransitWalkBanner";

/**
 * The engine, live-refresh polling and wake lock a browser transit trip needs.
 *
 * A child rather than a set of guarded hooks so the exclusion is structural: in
 * the installed shell the component is never mounted, so nothing added to it can
 * quietly start a second refresh-token consumer or a second alight owner beside
 * the native one.
 */
function BrowserTransitRuntime({ active }: { active: boolean }) {
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  useTransitNavigationEngine();
  useTransitLiveRefresh(active);
  useWakeLock(active && keepScreenOn);
  return null;
}

export function TransitNavigationView() {
  const status = useNavigationStore((s) => s.status);
  const kind = useNavigationStore((s) => s.kind);
  const itinerary = useNavigationStore((s) => s.itinerary);
  const transitProgress = useNavigationStore((s) => s.transitProgress);
  const setCameraMode = useNavigationStore((s) => s.setCameraMode);
  const { browserAuthority } = useMobileRuntime();
  const { completeArrival } = useNavigationMutations();
  const walkRepair = useTransitWalkRepair();
  useTransitFollowCamera();
  const units = useSettingsStore((s) => s.units);

  const mapCtx = useMapOptional();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const active = status !== "idle" && status !== "arrived" && kind === "transit";
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // This view is mounted for the whole session and renders nothing until a
  // transit trip runs, so an idle mount must not reserve the column either.
  const bannerClearance = useMapObstructionExtent("transit-nav-banner");
  const [bannerEl, setBannerEl] = useState<HTMLDivElement | null>(null);
  const hasWalkBanner = itinerary?.legs[transitProgress?.currentLegIndex ?? 0]?.mode === "walking";
  useNavChromeObstructions("transit", {
    isMobile,
    arrived: !active || !itinerary,
    bannerEl: hasWalkBanner ? bannerEl : null,
  });

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
  // recenter compass (shown whenever the camera is not following) resumes it.
  const handleOverview = () => {
    setCameraMode("overview");
    const coords = legs.flatMap((l) => l.geometry?.coordinates ?? []);
    if (!mapCtx || coords.length < 2) return;
    const box = geoJsonBBox({ type: "LineString", coordinates: coords } as GeoJSON.LineString);
    if (!box) return;
    // North-up and level: an overview is read like a map, not like the view the
    // follow camera was holding. Both asked for through the framing, which
    // measures a flat map and would otherwise fit the trip to a viewport the
    // tilt no longer matches.
    mapCtx.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      64,
      { bearing: 0, pitch: 0 },
    );
  };

  const expanded = isMobile ? sheetOpen : menuOpen;
  const toggleDetails = () => (isMobile ? setSheetOpen((o) => !o) : setMenuOpen((o) => !o));
  const showDetails = () => (isMobile ? setSheetOpen(true) : setMenuOpen(true));
  const toolbar = (
    <TransitJourneyToolbar
      legs={legs}
      currentLegIndex={currentLegIndex}
      expanded={expanded}
      onToggle={toggleDetails}
      mobile={isMobile}
    />
  );
  const footer = <TransitNavBottomBar itinerary={itinerary} currentLeg={currentLeg} />;
  const summary = (
    <>
      {currentLeg && currentLeg.mode !== "walking" && (
        <TransitLegBanner
          leg={currentLeg}
          legIndex={currentLegIndex}
          source={itinerary.source ?? itinerary.instance}
          transitProgress={transitProgress}
          transfer={transfer}
          presentation="sheet"
        />
      )}
      <TransitAlertBanner
        itinerary={itinerary}
        currentLegIndex={currentLegIndex}
        transitProgress={transitProgress}
        expanded={expanded}
        onExpand={showDetails}
      />
      {currentLeg?.route && transfer && (
        <TransitConnectionRisk leg={currentLeg} transfer={transfer} inline />
      )}
      <TransitJourneyControls
        walkRepair={walkRepair}
        showRidingDestination={false}
        onAlternatives={() => setAlternativesOpen(true)}
      />
    </>
  );
  const details = (
    <Box id="transit-journey-details">
      <TransitJourneySheet
        itinerary={itinerary}
        currentLegIndex={currentLegIndex}
        transitProgress={transitProgress}
        showQueryNotice={false}
        showDataStatus={false}
        scroll={false}
      />
      <TransitNavMenu onOverview={handleOverview} onOpenSettings={() => setSettingsOpen(true)} />
    </Box>
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
      }}
    >
      {browserAuthority && (
        <>
          <BrowserTransitRuntime active={active} />
          <TransitGuidanceCues
            itinerary={itinerary}
            legIndex={currentLegIndex}
            transitProgress={transitProgress}
            transfer={transfer}
            active={active}
          />
        </>
      )}
      {status === "arrived" ? (
        <Box
          sx={{
            pointerEvents: "auto",
            m: "auto",
            bgcolor: "background.paper",
            borderRadius: "28px",
          }}
        >
          <TransitArrivalCard itinerary={itinerary} onClose={() => void completeArrival()} />
          <TransitJourneyControls
            walkRepair={walkRepair}
            onAlternatives={() => setAlternativesOpen(true)}
          />
        </Box>
      ) : (
        <>
          {hasWalkBanner && currentLeg && (
            <Box
              ref={setBannerEl}
              sx={{
                pointerEvents: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 1,
                p: 2,
                pt: NAV_CHROME_TOP,
                flexShrink: 0,
                ...(!isMobile
                  ? { width: 1, maxWidth: NAV_LANDSCAPE_PANEL_WIDTH + 32, alignSelf: "flex-start" }
                  : {}),
              }}
            >
              {isGuidedWalk ? (
                <TransitWalkBanner
                  leg={currentLeg}
                  transitProgress={transitProgress}
                  units={units}
                />
              ) : (
                <TransitLegBanner
                  leg={currentLeg}
                  source={itinerary.source ?? itinerary.instance}
                  legIndex={currentLegIndex}
                  transitProgress={transitProgress}
                  transfer={transfer}
                />
              )}
            </Box>
          )}
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              ...(isMobile
                ? {}
                : {
                    minHeight: 0,
                    flex: 1,
                    px: 2,
                    pb: 2,
                    pt: hasWalkBanner ? 0 : NAV_CHROME_TOP,
                    alignItems: "flex-start",
                  }),
            }}
          >
            {isMobile ? (
              <NavSwipeSheet
                topClearance={bannerClearance}
                expanded={sheetOpen}
                onExpandedChange={setSheetOpen}
                toolbar={toolbar}
                footer={footer}
                header={summary}
              >
                {details}
              </NavSwipeSheet>
            ) : (
              <Box
                sx={{
                  pointerEvents: "auto",
                  width: 1,
                  maxWidth: NAV_LANDSCAPE_PANEL_WIDTH,
                  maxHeight: "100%",
                  bgcolor: "background.paper",
                  borderRadius: "28px",
                  boxShadow: 6,
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  overflow: "hidden",
                }}
              >
                <Box sx={{ flexShrink: 0 }}>{toolbar}</Box>
                <Box
                  sx={{
                    minHeight: 0,
                    overflowY: "auto",
                    overflowX: "hidden",
                    scrollPaddingBlock: 1,
                  }}
                >
                  {summary}
                  <Collapse in={menuOpen} timeout={reduceMotion ? 0 : "auto"} unmountOnExit>
                    {details}
                  </Collapse>
                </Box>
                <Box sx={{ flexShrink: 0 }}>{footer}</Box>
              </Box>
            )}
          </Box>
        </>
      )}
      <TransitAlternativesDialog
        open={alternativesOpen}
        onClose={() => setAlternativesOpen(false)}
      />
      <NavigationSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Box>
  );
}
