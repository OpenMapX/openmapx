"use client";

import Box from "@mui/material/Box";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { DetentConfig } from "@/components/panels/sheet/detents";
import { MobileBottomSheet } from "@/components/panels/sheet/MobileBottomSheet";
import { useMapFooterBox } from "@/lib/mapFooterCenter";
import { getMapObstructionInsets, subscribeMapObstructions } from "@/lib/mapObstructions";
import { DEFAULT_FOLLOW_CAP_FRACTION, useWindowHeight } from "@/lib/mobilePanelHeight";

/** Predict docking from the summary alone, not from the credits' current parent. */
export function navigationPeekFooterHeight(
  summaryPx: number,
  viewportPx: number,
  topClearance: number,
  footerPx: number,
): number {
  if (viewportPx <= 0 || footerPx <= 0) return 0;
  const followPx = Math.min(summaryPx, viewportPx * DEFAULT_FOLLOW_CAP_FRACTION);
  const mapBudget = Math.max(0, viewportPx - topClearance - followPx);
  return summaryPx > followPx + 1 || footerPx > mapBudget + 1 ? footerPx : 0;
}

const getTopInset = () => getMapObstructionInsets().top;
const getServerTopInset = () => 0;

export function navigationUsesCompactPeek(
  requiredPx: number,
  viewportPx: number,
  topClearance: number,
  safeTopPx: number,
): boolean {
  return (
    viewportPx > 0 && requiredPx > Math.max(0, viewportPx - Math.max(topClearance, safeTopPx) - 8)
  );
}

// Cap the expanded sheet so the maneuver banner up top stays visible.
const MAX_HEIGHT_FRACTION = 0.9;

/**
 * Two measured detents: summary and full journey/menu. Optional toolbar/footer
 * use the shared sheet's pinned slots, leaving the entire body scrollable on
 * short screens. Without pinned chrome, driving keeps its existing handle and
 * safe-area spacer. Measurements exclude the safe inset, which is counted once
 * in the detent and supplied by the shared footer when it owns map attribution.
 */
export function NavSwipeSheet({
  expanded,
  onExpandedChange,
  header,
  children,
  topClearance = 0,
  toolbar,
  footer,
}: {
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  header: ReactNode;
  children: ReactNode;
  /** Keep expanded content below the measured instruction banner. */
  topClearance?: number;
  /** Transit supplies compact pinned chrome. Driving retains the default handle. */
  toolbar?: ReactNode;
  footer?: ReactNode;
}) {
  const t = useTranslations("navigation");
  const headerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [headerPx, setHeaderPx] = useState(0);
  const [menuPx, setMenuPx] = useState(0);
  const viewportH = useWindowHeight();
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [chromePx, setChromePx] = useState(0);
  const safeBottomRef = useRef<HTMLDivElement | null>(null);
  const [safeBottomPx, setSafeBottomPx] = useState(0);
  const [safeTopPx, setSafeTopPx] = useState(0);
  const mapTop = useSyncExternalStore(subscribeMapObstructions, getTopInset, getServerTopInset);
  const mapFooter = useMapFooterBox();
  const pinned = toolbar != null || footer != null;
  useLayoutEffect(() => {
    if (!pinned) return;
    const measure = () => {
      setChromePx((toolbarRef.current?.offsetHeight ?? 0) + (footerRef.current?.offsetHeight ?? 0));
      const probe = safeBottomRef.current;
      if (probe) {
        const style = getComputedStyle(probe);
        setSafeBottomPx(Number.parseFloat(style.height) || 0);
        setSafeTopPx(Number.parseFloat(style.paddingTop) || 0);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    if (footerRef.current) observer.observe(footerRef.current);
    if (safeBottomRef.current) observer.observe(safeBottomRef.current);
    return () => observer.disconnect();
  }, [pinned]);

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
  const cap =
    viewportH > 0 ? viewportH * (pinned ? 1 : MAX_HEIGHT_FRACTION) : headerPx + menuPx + chromePx;
  const peekFooterPx = pinned
    ? navigationPeekFooterHeight(
        headerPx + chromePx + safeBottomPx,
        viewportH,
        Math.max(topClearance, mapTop),
        mapFooter.height,
      )
    : 0;
  // When the whole summary cannot fit, use a compact route-strip peek.
  // Expanding restores the summary in the scrollable body, so its actions stay reachable.
  const compactPeek =
    pinned &&
    navigationUsesCompactPeek(
      headerPx + chromePx + safeBottomPx + peekFooterPx,
      viewportH,
      topClearance,
      safeTopPx,
    );
  const peekContentPx = compactPeek ? chromePx : headerPx + chromePx + peekFooterPx;
  const expandedContentPx = Math.min(
    headerPx + menuPx + chromePx + (pinned ? mapFooter.height : 0),
    cap,
  );

  // No mid: the shared sheet then falls back to the default follow-cap
  // fraction for the map chrome above it, instead of tracking this sheet.
  const detents = useMemo<DetentConfig>(() => {
    const maxHeight =
      topClearance > 0
        ? `min(calc(${Math.round(expandedContentPx)}px + var(--omx-safe-bottom)), calc(100dvh - ${Math.ceil(topClearance + 8)}px))`
        : pinned
          ? `min(calc(${Math.round(expandedContentPx)}px + var(--omx-safe-bottom)), calc(100dvh - var(--omx-safe-top) - 8px))`
          : `calc(${Math.round(expandedContentPx)}px + var(--omx-safe-bottom))`;
    const peek = `calc(${Math.round(peekContentPx)}px + var(--omx-safe-bottom))`;
    return { peek, maxHeight, initial: "peek" };
  }, [peekContentPx, expandedContentPx, topClearance, pinned]);

  return (
    <MobileBottomSheet
      id="nav-sheet"
      zIndex={1}
      stackLevel={1300}
      detents={detents}
      detent={expanded ? "full" : "peek"}
      onDetentChange={(next) => onExpandedChange(next === "full")}
      hideHandle
      disableContentSafeArea
      header={toolbar != null ? <Box ref={toolbarRef}>{toolbar}</Box> : undefined}
      footer={footer != null ? <Box ref={footerRef}>{footer}</Box> : undefined}
      contentSx={pinned ? { scrollPaddingTop: 8, scrollPaddingBottom: 8 } : undefined}
    >
      {pinned && (
        <Box
          ref={safeBottomRef}
          aria-hidden
          sx={{
            position: "absolute",
            width: 0,
            height: "var(--omx-safe-bottom)",
            paddingTop: "var(--omx-safe-top)",
            boxSizing: "content-box",
            pointerEvents: "none",
            visibility: "hidden",
          }}
        />
      )}
      <Box
        aria-hidden={compactPeek && !expanded ? true : undefined}
        inert={compactPeek && !expanded ? true : undefined}
        sx={compactPeek && !expanded ? { maxHeight: 0, overflow: "hidden" } : undefined}
      >
        <Box ref={headerRef}>
          {!pinned && (
            <Box
              component="button"
              type="button"
              onClick={() => onExpandedChange(!expanded)}
              aria-label={t("resizePanel")}
              aria-expanded={expanded}
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
                minHeight: 44,
                border: 0,
                bgcolor: "transparent",
                color: "inherit",
                cursor: "pointer",
                p: 0,
                "&:focus-visible": {
                  outline: "2px solid",
                  outlineColor: "primary.main",
                  outlineOffset: -2,
                  borderRadius: 2,
                },
              }}
            >
              <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: "action.disabled" }} />
            </Box>
          )}
          {header}
        </Box>
      </Box>
      {!pinned && !expanded && (
        <Box
          sx={{ height: "var(--omx-safe-bottom)", "[data-map-footer-owned] &": { height: 0 } }}
        />
      )}
      <Box
        ref={menuRef}
        aria-hidden={pinned && !expanded ? true : undefined}
        inert={pinned && !expanded ? true : undefined}
      >
        {children}
      </Box>
      {!pinned && expanded && (
        <Box
          sx={{ height: "var(--omx-safe-bottom)", "[data-map-footer-owned] &": { height: 0 } }}
        />
      )}
    </MobileBottomSheet>
  );
}
