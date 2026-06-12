"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import type { SxProps, Theme } from "@mui/material/styles";
import { motion, type PanInfo } from "framer-motion";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { haptics } from "@/lib/haptics";
import { useMobilePanelHeightTracker } from "@/lib/mobilePanelHeight";
import { useVisualViewport } from "@/lib/useVisualViewport";

// Snap heights as fractions of viewport — a three-step sheet.
const SNAP_FRACTIONS = [0.3, 0.65, 0.95] as const;
const DEFAULT_SNAP_INDEX = 1;

/**
 * Fraction of viewport beyond which UI that *follows* the sheet (e.g. the
 * right-side map controls) should stop tracking the sheet's height. Above
 * this point the sheet covers the controls anyway, so anchoring them to its
 * top edge would push them off-screen.
 */
export const MOBILE_SHEET_FOLLOW_CAP_FRACTION = SNAP_FRACTIONS[1];
const MIN_HEIGHT_FRACTION = 0.18;
const MAX_HEIGHT_FRACTION = 0.96;
// |velocity.y| above which a flick promotes to the next snap rather than
// the geometrically nearest one.
const FLICK_VELOCITY = 500;
const SNAP_TRANSITION_MS = 280;
const SNAP_TIMING = "cubic-bezier(0.32, 0.72, 0, 1)";

interface Props {
  /** Stable id for the height tracker (so map controls can offset above it). */
  id: string;
  zIndex: number;
  contentSx?: SxProps<Theme>;
  children: ReactNode;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

const FloatingHandleContext = createContext<((floating: boolean) => void) | null>(null);

/**
 * Opt the surrounding mobile bottom sheet into a floating handle layout —
 * the drag pill renders absolutely on top of the content (with a soft scrim
 * so it stays legible) instead of in its own band above the content.
 *
 * Use this in panels whose first child is a full-bleed visual (e.g. a place's
 * photo hero), so the photo can reach the rounded sheet corners. Pass `false`
 * (or stop rendering the panel) to revert to the default banded layout.
 *
 * No-op outside a mobile bottom sheet.
 */
export function useFloatingMobileSheetHandle(enabled: boolean) {
  const setFloating = useContext(FloatingHandleContext);
  useEffect(() => {
    if (!setFloating) return;
    setFloating(enabled);
    return () => setFloating(false);
  }, [enabled, setFloating]);
}

export function MobileBottomSheet({ id, zIndex, contentSx, children }: Props) {
  const [snapIdx, setSnapIdx] = useState(DEFAULT_SNAP_INDEX);
  const [vh, setVh] = useState(0);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [floating, setFloating] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  useMobilePanelHeightTracker(id, el);
  const { keyboardInset } = useVisualViewport();

  const dragStartHeightRef = useRef(0);
  const animatingRef = useRef(false);

  useEffect(() => {
    const update = () => setVh(window.innerHeight);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Track whether focus is on an input *inside* the sheet, so we only lift the
  // sheet above the keyboard when the user is actually typing in it (not when
  // the keyboard comes from the top search bar).
  useEffect(() => {
    if (!el) return;
    const onFocusIn = () => setFocusInside(el.contains(document.activeElement));
    const onFocusOut = () =>
      requestAnimationFrame(() => setFocusInside(el.contains(document.activeElement)));
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
    };
  }, [el]);

  // Lift the sheet by the keyboard height while editing inside it, capping the
  // height so the top stays on-screen and the focused field scrolls into view.
  const keyboardLift = focusInside && keyboardInset > 0 ? keyboardInset : 0;

  const heightForSnap = (idx: number) => Math.round(vh * SNAP_FRACTIONS[idx]);

  function setInlineHeight(px: number | null) {
    if (!el) return;
    el.style.height = px === null ? "" : `${px}px`;
  }
  function setInlineTransition(value: string | null) {
    if (!el) return;
    el.style.transition = value ?? "";
  }

  function handlePanStart() {
    if (!el) return;
    dragStartHeightRef.current = el.getBoundingClientRect().height;
    setInlineTransition("none");
  }

  function handlePan(_: PointerEvent, info: PanInfo) {
    if (vh === 0) return;
    const next = clamp(
      dragStartHeightRef.current - info.offset.y,
      vh * MIN_HEIGHT_FRACTION,
      vh * MAX_HEIGHT_FRACTION,
    );
    setInlineHeight(next);
  }

  function handlePanEnd(_: PointerEvent, info: PanInfo) {
    if (!el) return;
    const currentH = el.getBoundingClientRect().height;
    const v = info.velocity.y;

    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < SNAP_FRACTIONS.length; i++) {
      const dist = Math.abs(currentH - heightForSnap(i));
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (v < -FLICK_VELOCITY && bestIdx < SNAP_FRACTIONS.length - 1) bestIdx += 1;
    else if (v > FLICK_VELOCITY && bestIdx > 0) bestIdx -= 1;

    if (bestIdx !== snapIdx) haptics.tap();
    animatingRef.current = true;
    setInlineTransition(`height ${SNAP_TRANSITION_MS}ms ${SNAP_TIMING}`);
    setInlineHeight(heightForSnap(bestIdx));
    setSnapIdx(bestIdx);
    window.setTimeout(() => {
      animatingRef.current = false;
      // Drop inline overrides; React's sx height takes over.
      setInlineHeight(null);
      setInlineTransition(null);
    }, SNAP_TRANSITION_MS + 40);
  }

  const handle = (
    <motion.div
      onPanStart={handlePanStart}
      onPan={handlePan}
      onPanEnd={handlePanEnd}
      style={
        floating
          ? {
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              touchAction: "none",
              padding: "8px 0 12px",
              display: "flex",
              justifyContent: "center",
              cursor: "grab",
              zIndex: 1,
            }
          : {
              flexShrink: 0,
              touchAction: "none",
              padding: "8px 0 4px",
              display: "flex",
              justifyContent: "center",
              cursor: "grab",
            }
      }
      aria-label="Resize panel"
      role="separator"
    >
      <Box
        sx={{
          width: 36,
          height: 4,
          borderRadius: 2,
          bgcolor: "action.disabled",
        }}
      />
    </motion.div>
  );

  return (
    <Paper
      ref={setEl}
      elevation={6}
      sx={[
        (theme) => ({
          position: "absolute",
          bottom: keyboardLift,
          left: 0,
          right: 0,
          width: "100%",
          height: `${SNAP_FRACTIONS[snapIdx] * 100}dvh`,
          ...(keyboardLift > 0 ? { maxHeight: `calc(100dvh - ${keyboardLift}px)` } : {}),
          overflow: "hidden",
          borderRadius: "16px 16px 0 0",
          boxShadow: 6,
          zIndex,
          display: "flex",
          flexDirection: "column",
          ...theme.applyStyles("dark", { bgcolor: "background.default" }),
        }),
        ...(Array.isArray(contentSx) ? contentSx : contentSx ? [contentSx] : []),
      ]}
    >
      <FloatingHandleContext.Provider value={setFloating}>
        {!floating && handle}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overscrollBehavior: "contain",
            paddingBottom: "var(--omx-safe-bottom)",
          }}
        >
          {children}
        </Box>
        {floating && handle}
      </FloatingHandleContext.Provider>
    </Paper>
  );
}
