"use client";

import Box from "@mui/material/Box";
import { useTranslations } from "next-intl";
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DetentConfig } from "@/components/panels/sheet/detents";
import { MobileBottomSheet } from "@/components/panels/sheet/MobileBottomSheet";
import { useWindowHeight } from "@/lib/mobilePanelHeight";

// Cap the expanded sheet so the maneuver banner up top stays visible.
const MAX_HEIGHT_FRACTION = 0.9;

/**
 * The navigation sheet: a bottom-anchored card with a pinned header (the summary
 * bar) that swipes up to reveal the menu below it. A thin adapter over the
 * shared mobile bottom sheet, configured with a two-snap detent (no mid) so the
 * two rest positions are exactly the header and the header-plus-menu, rather
 * than viewport fractions like every other sheet in the app. Controlled:
 * `expanded` drives which of the two snaps the sheet rests at, and a drag or a
 * tap on the handle reports back through `onExpandedChange`.
 *
 * The header and menu are measured with a `ResizeObserver` and fed to the
 * shared sheet as pixel peek/max-height detents, rather than using its
 * `content-height` mode — that mode is mutually exclusive with the
 * `nested-scroll` + `expand-to-scroll` mode this sheet (like every other one)
 * runs in. The measurement is seeded synchronously in a layout effect, so the
 * first paint already has the right numbers instead of momentarily collapsing
 * to a 0px sheet.
 *
 * Safe-area handling is a dedicated spacer that swaps position instead of
 * padding baked onto either measured box: it sits right after the header while
 * collapsed (so the summary bar lifts above the home indicator with nothing
 * else visible below it) and right after the menu while expanded (matching the
 * generic sheet's convention of landing the inset once, after the content).
 * Moving it keeps `headerPx`/`menuPx` themselves invariant across `expanded`
 * toggling — the inset is composed into the detent lengths as a CSS `calc()`
 * against `--omx-safe-bottom` instead, so there is nothing to re-measure or
 * resnap to when the swap happens.
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
  const t = useTranslations("navigation");
  const headerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [headerPx, setHeaderPx] = useState(0);
  const [menuPx, setMenuPx] = useState(0);
  const viewportH = useWindowHeight();

  // Layout effects so the first paint already has the right numbers: an
  // ordinary effect only fills these in after the browser has already painted
  // a 0px sheet, and the library's own IntersectionObserver bails on a
  // zero-height host (`if (!entries[0]?.rootBounds?.height) return`), so no
  // snap state would exist until a second pass.
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    setHeaderPx(el.offsetHeight);
    const ro = new ResizeObserver(() => setHeaderPx(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    setMenuPx(el.offsetHeight);
    const ro = new ResizeObserver(() => setMenuPx(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // `headerPx` and `menuPx` are pure content measurements — no safe-area inset
  // baked in — so this stays invariant across `expanded` toggling too.
  const cap = viewportH > 0 ? viewportH * MAX_HEIGHT_FRACTION : headerPx + menuPx;
  const expandedContentPx = Math.min(headerPx + menuPx, cap);

  // No mid: the shared sheet then falls back to the default follow-cap
  // fraction for the map chrome above it, instead of tracking this sheet.
  const detents = useMemo<DetentConfig>(
    () => ({
      peek: `calc(${Math.round(headerPx)}px + var(--omx-safe-bottom))`,
      maxHeight: `calc(${Math.round(expandedContentPx)}px + var(--omx-safe-bottom))`,
      initial: "peek",
    }),
    [headerPx, expandedContentPx],
  );

  return (
    <MobileBottomSheet
      id="nav-sheet"
      zIndex={1}
      detents={detents}
      detent={expanded ? "full" : "peek"}
      onDetentChange={(next) => onExpandedChange(next === "full")}
      hideHandle
      disableContentSafeArea
    >
      <Box ref={headerRef}>
        <Box
          onClick={() => onExpandedChange(!expanded)}
          aria-label={t("resizePanel")}
          role="separator"
          sx={{ display: "flex", justifyContent: "center", pt: 1, pb: 0.5 }}
        >
          <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: "action.disabled" }} />
        </Box>
        {header}
      </Box>
      {!expanded && <Box sx={{ height: "var(--omx-safe-bottom)" }} />}
      <Box ref={menuRef}>{children}</Box>
      {expanded && <Box sx={{ height: "var(--omx-safe-bottom)" }} />}
    </MobileBottomSheet>
  );
}
