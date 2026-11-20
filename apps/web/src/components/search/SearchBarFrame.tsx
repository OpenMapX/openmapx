"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import { useActiveSidePanel, useSidebarStore } from "@openmapx/core";
import { type FocusEventHandler, type ReactNode, useState } from "react";
import { SEARCH_BAR_INSET, SEARCH_BAR_TOP } from "@/lib/layout";
import { useMeasuredMapObstruction } from "@/lib/mapObstructions";

interface SearchBarFrameProps {
  /** The map-obstruction id this bar registers under, unique per surface. */
  obstructionId: string;
  /** Whether the bar rides on the map, where it hides part of it. */
  onMap: boolean;
  isMobile: boolean;
  fullScreen: boolean;
  focused: boolean;
  /** Whether results open below the input, inside the same card. */
  openBelow: boolean;
  onFocusCapture: FocusEventHandler;
  onBlurCapture: FocusEventHandler;
  children: ReactNode;
}

/** The floating card the search input and its inline results live in. */
export function SearchBarFrame({
  obstructionId,
  onMap,
  isMobile,
  fullScreen,
  focused,
  openBelow,
  onFocusCapture,
  onBlurCapture,
  children,
}: SearchBarFrameProps) {
  const [barEl, setBarEl] = useState<HTMLDivElement | null>(null);
  const { isOpen: hasSidePanel } = useActiveSidePanel();
  const sidebarCollapsed = useSidebarStore((s) => s.collapsed);
  const docked = !isMobile && hasSidePanel && !sidebarCollapsed && !focused;
  // Desktop keeps the bar inside the rail's column, which is already registered
  // as an obstruction; a full-screen search covers the map entirely, and
  // framing against that would leave nothing to aim at. The street-level viewer
  // covers it just as completely, so the bar riding on it registers nothing.
  useMeasuredMapObstruction(obstructionId, "top", onMap && isMobile && !fullScreen ? barEl : null);
  const raised = focused ? 4 : 2;
  return (
    <Box
      ref={setBarEl}
      // React focus capture follows our credit dialogs through their portals.
      // Moving among the input, controls and dialogs still belongs to search;
      // leaving either search surface starts the ordinary dismissal delay.
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      sx={{
        position: "absolute",
        top: SEARCH_BAR_TOP,
        left: `calc(${SEARCH_BAR_INSET}px + var(--omx-safe-left))`,
        right: {
          xs: `calc(${SEARCH_BAR_INSET}px + var(--omx-safe-right))`,
          sm: "auto",
        },
        // Above CategoryChips (z-index 10) so the dropdown covers the chip
        // band on mobile when the user is typing — the chips stay rendered
        // (cheap, ready when search is dismissed) but visually hidden. In
        // fullscreen the bar sits above the white backdrop (z 12).
        zIndex: fullScreen ? 13 : 11,
        width: { xs: "auto", sm: "auto" },
      }}
    >
      <Paper
        elevation={fullScreen || docked ? 0 : raised}
        sx={{
          width: { xs: "100%", sm: 376 },
          // Over the open side panel the bar is part of the panel: an outline
          // instead of a shadow, which would float it above its own surface.
          outline: docked ? "1px solid var(--omx-border-light)" : "none",
          outlineOffset: -1,
          borderRadius: !fullScreen && openBelow ? "24px 24px 16px 16px" : "24px",
          overflow: "hidden",
          transition: "box-shadow 0.2s, border-radius 0.15s, background-color 0.15s",
          // Bar turns into a light grey pill while focused,
          // signalling the active state without changing
          // its size or position.
          bgcolor: fullScreen ? "action.hover" : "background.paper",
        }}
      >
        {children}
      </Paper>
    </Box>
  );
}
