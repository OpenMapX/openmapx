"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import { motion, type PanInfo } from "framer-motion";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from "react";

// Cap the expanded sheet so the maneuver banner up top stays visible.
const MAX_HEIGHT_FRACTION = 0.9;
// |velocity.y| above which a flick decides the snap regardless of position.
const FLICK_VELOCITY = 500;
const SNAP_MS = 260;
const SNAP_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/**
 * The navigation sheet: a bottom-anchored card with a pinned header (the summary
 * bar) that swipes up to reveal the menu below it. Two snap states — collapsed
 * (just the header) and expanded (header + menu) — measured from content so the
 * collapsed state is exactly the summary bar. Controlled: `expanded` reflects the
 * menu state so a menu row (or the resize) can collapse it, and a drag reports
 * back through `onExpandedChange`.
 *
 * `box-sizing: content-box` + `paddingBottom` keeps the safe-area strip below the
 * content: the JS height is content-only, so a collapsed sheet still lifts the
 * header above the home indicator, and expanded has no gap before the menu.
 */
export function NavSwipeSheet({
  expanded,
  onExpandedChange,
  header,
  children,
}: {
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  header: ReactNode;
  children: ReactNode;
}) {
  const paperRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null); // handle + header (collapsed height)
  const fullRef = useRef<HTMLDivElement | null>(null); // handle + header + menu (expanded height)
  const dragStartRef = useRef(0);

  const collapsedH = useCallback(() => topRef.current?.offsetHeight ?? 0, []);
  const expandedH = useCallback(
    () => Math.min(fullRef.current?.offsetHeight ?? 0, window.innerHeight * MAX_HEIGHT_FRACTION),
    [],
  );

  const applyHeight = useCallback((px: number, animate: boolean) => {
    const el = paperRef.current;
    if (!el) return;
    el.style.transition = animate ? `height ${SNAP_MS}ms ${SNAP_EASE}` : "none";
    el.style.height = `${px}px`;
  }, []);

  // Reflect the controlled state (and keep it right across content/viewport
  // changes). Layout effect so the first paint is already at the right height.
  useLayoutEffect(() => {
    applyHeight(expanded ? expandedH() : collapsedH(), false);
  }, [expanded, applyHeight, expandedH, collapsedH]);

  useEffect(() => {
    const onResize = () => applyHeight(expanded ? expandedH() : collapsedH(), false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [expanded, applyHeight, expandedH, collapsedH]);

  const onPanStart = () => {
    dragStartRef.current = paperRef.current?.offsetHeight ?? collapsedH();
    if (paperRef.current) paperRef.current.style.transition = "none";
  };
  const onPan = (_: PointerEvent, info: PanInfo) => {
    const next = Math.max(
      collapsedH(),
      Math.min(expandedH(), dragStartRef.current - info.offset.y),
    );
    if (paperRef.current) paperRef.current.style.height = `${next}px`;
  };
  const onPanEnd = (_: PointerEvent, info: PanInfo) => {
    const h = paperRef.current?.offsetHeight ?? collapsedH();
    let next = h >= (collapsedH() + expandedH()) / 2;
    if (info.velocity.y < -FLICK_VELOCITY) next = true;
    else if (info.velocity.y > FLICK_VELOCITY) next = false;
    applyHeight(next ? expandedH() : collapsedH(), true);
    onExpandedChange(next);
  };

  return (
    <Paper
      ref={paperRef}
      elevation={6}
      sx={(theme) => ({
        pointerEvents: "auto",
        width: "100%",
        boxSizing: "content-box",
        paddingBottom: "var(--omx-safe-bottom)",
        overflow: "hidden",
        borderRadius: "16px 16px 0 0",
        boxShadow: 6,
        ...theme.applyStyles("dark", { bgcolor: "background.default" }),
      })}
    >
      <Box ref={fullRef}>
        <Box ref={topRef}>
          <motion.div
            onPanStart={onPanStart}
            onPan={onPan}
            onPanEnd={onPanEnd}
            onClick={() => onExpandedChange(!expanded)}
            style={{ touchAction: "none", cursor: "grab" }}
            aria-label="Resize navigation panel"
            role="separator"
          >
            <Box sx={{ display: "flex", justifyContent: "center", pt: 1, pb: 0.5 }}>
              <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: "action.disabled" }} />
            </Box>
          </motion.div>
          {header}
        </Box>
        {children}
      </Box>
    </Paper>
  );
}
