"use client";

import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useNavigationStore, useSidebarStore } from "@openmapx/core";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useEffect } from "react";
import { nextTransferFor } from "@/lib/navigation/transitTransfer";
import { useTransitNavigationEngine } from "@/lib/navigation/useTransitNavigationEngine";
import { useWakeLock } from "@/lib/useWakeLock";
import { ArrivalCard } from "./ArrivalCard";
import { NavBottomSheet } from "./NavBottomSheet";
import { TransitLegBanner } from "./TransitLegBanner";
import { TransitNavBottomBar } from "./TransitNavBottomBar";

export function TransitNavigationView() {
  const status = useNavigationStore((s) => s.status);
  const kind = useNavigationStore((s) => s.kind);
  const itinerary = useNavigationStore((s) => s.itinerary);
  const transitProgress = useNavigationStore((s) => s.transitProgress);
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const stopNavigation = useNavigationStore((s) => s.stopNavigation);

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const active = status !== "idle" && status !== "arrived" && kind === "transit";

  // Hooks must run before any early return.
  useTransitNavigationEngine();
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
          <ArrivalCard onClose={stopNavigation} />
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
            }}
          >
            {currentLeg && (
              <TransitLegBanner
                leg={currentLeg}
                legIndex={currentLegIndex}
                totalLegs={legs.length}
                transitProgress={transitProgress}
                transfer={transfer}
              />
            )}
          </Box>

          <Box sx={{ display: "flex", flexDirection: "column" }}>
            {isMobile ? (
              <NavBottomSheet>
                <TransitNavBottomBar itinerary={itinerary} currentLeg={currentLeg} />
              </NavBottomSheet>
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
                <TransitNavBottomBar itinerary={itinerary} currentLeg={currentLeg} />
              </Box>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
