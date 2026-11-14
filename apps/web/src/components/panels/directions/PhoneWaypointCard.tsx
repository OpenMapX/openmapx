"use client";

import Paper from "@mui/material/Paper";
import Portal from "@mui/material/Portal";
import { type ReactNode, useEffect, useState } from "react";
import { topInset } from "@/lib/layout";
import { useMeasuredMapObstruction } from "@/lib/mapObstructions";
import { useStopSearchStore } from "@/stores/stopSearchStore";

/** Where the card ends, read by the directions sheet's tallest detent. */
export const WAYPOINT_CARD_BOTTOM_VAR = "--omx-waypoint-card-bottom";

/**
 * On a phone, the trip's stops float in a card at the top of the map instead
 * of filling the bottom sheet, so the sheet can show the routes at its middle
 * height. The card registers as a top obstruction, which keeps the camera and
 * the map controls clear of it. Its fields open the main search to choose a
 * stop (see `useStopSearchStore`).
 */
export function PhoneWaypointCard({ children }: { children: ReactNode }) {
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  // The stop search covers the screen; the card would float above it.
  const searching = useStopSearchStore((s) => s.request !== null);
  useMeasuredMapObstruction("directions-waypoints", "top", card);
  // A sheet dragged fully open stops below the card.
  useEffect(() => {
    if (!card) return;
    const root = document.documentElement;
    const update = () =>
      root.style.setProperty(WAYPOINT_CARD_BOTTOM_VAR, `${card.getBoundingClientRect().bottom}px`);
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(card);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(WAYPOINT_CARD_BOTTOM_VAR);
    };
  }, [card]);

  return (
    // Out of the sheet's own stacking and scrolling, onto the map.
    <Portal>
      <Paper
        ref={setCard}
        elevation={3}
        sx={{
          position: "fixed",
          top: topInset(8),
          left: "calc(8px + var(--omx-safe-left))",
          right: "calc(8px + var(--omx-safe-right))",
          zIndex: 12,
          visibility: searching ? "hidden" : "visible",
          borderRadius: "16px",
          bgcolor: "background.paper",
        }}
      >
        {children}
      </Paper>
    </Portal>
  );
}
