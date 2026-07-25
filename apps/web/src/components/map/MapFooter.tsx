"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import { useNavigationStore, useSidebarStore } from "@openmapx/core";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { isPanelShiftActive, PANEL_WIDTH } from "@/lib/layout";
import { useMapAttributionHtml } from "@/lib/mapAttributionStore";
import { CREDITS_SEPARATOR, CREDITS_SX } from "./MapCredits";

// Pixels to lift the footer while navigating, so it clears the navigation
// bottom sheet instead of hiding behind it.
const NAV_FOOTER_LIFT = 96;

// Below this much free space between the two groups they stop reading as two
// separate bars, so they're painted as one instead.
const MERGE_GAP = 16;

/**
 * The bottom strip: legal links on the left, map credits on the right, both
 * always visible (no collapsed ⓘ toggle; MapLibre's built-in
 * AttributionControl is disabled on the main map, see `MapCanvas`).
 *
 * Three responsive stages: while there's room the two groups sit against
 * opposite edges as separate bars; once the space between them runs out they
 * are painted as one continuous bar; and if even that doesn't fit, the credits
 * wrap onto their own line(s) within that single bar (`marginLeft: auto` keeps
 * them right-aligned on whichever line they land on).
 *
 * Merging only moves which element paints the background — the layout is
 * identical in both stages — so measuring the gap can't feed back into the
 * measurement and oscillate.
 */
export function MapFooter() {
  const t = useTranslations("footer");
  const sidebarOpen = useSidebarStore((s) => s.activeSidebarId !== null);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const shifted = isPanelShiftActive({ sidebarOpen, sidebarCollapsed: collapsed, navigating });
  const credits = useMapAttributionHtml();
  const creditsHtml = credits.join(CREDITS_SEPARATOR);

  const containerRef = useRef<HTMLElement>(null);
  const linksRef = useRef<HTMLDivElement>(null);
  const creditsRef = useRef<HTMLDivElement>(null);
  const [merged, setMerged] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: credit changes resize the strip and (re)mount the element the observer watches
  useEffect(() => {
    const container = containerRef.current;
    const links = linksRef.current;
    if (!container || !links) return;
    const measure = () => {
      const creditsEl = creditsRef.current;
      if (!creditsEl) {
        setMerged(false);
        return;
      }
      const l = links.getBoundingClientRect();
      const c = creditsEl.getBoundingClientRect();
      const sameLine = Math.abs(l.top - c.top) < 1;
      setMerged(!sameLine || c.left - l.right < MERGE_GAP);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(links);
    if (creditsRef.current) observer.observe(creditsRef.current);
    return () => observer.disconnect();
  }, [creditsHtml]);

  // Typography/colors come from the shared credits style so the footer and the
  // embedded maps' `<MapCredits>` can't drift apart. In merged mode the
  // container paints the background instead of the two bars, so they read as one.
  const { bgcolor: background, px, py, ...creditsTypography } = CREDITS_SX;
  const barSx = {
    maxWidth: "100%",
    bgcolor: merged ? "transparent" : background,
    px,
    py,
    pointerEvents: "auto",
  } as const;

  return (
    <Box
      component="footer"
      ref={containerRef}
      sx={{
        bgcolor: merged ? background : "transparent",
        position: "absolute",
        bottom: `calc(var(--omx-safe-bottom) + ${navigating ? NAV_FOOTER_LIFT : 0}px)`,
        left: {
          xs: "var(--omx-safe-left)",
          sm: shifted ? `calc(${PANEL_WIDTH}px + var(--omx-safe-left))` : "var(--omx-safe-left)",
        },
        right: "var(--omx-safe-right)",
        zIndex: 5,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        justifyContent: "flex-start",
        columnGap: 0,
        rowGap: 0,
        // Only the two bars take pointer events; the empty space between them
        // stays a draggable part of the map.
        pointerEvents: "none",
        ...creditsTypography,
        transition: "left 0.25s ease, bottom 0.25s ease",
      }}
    >
      <Box ref={linksRef} sx={{ ...barSx, display: "flex", flexWrap: "wrap", columnGap: "0.6em" }}>
        <Link component={NextLink} href="/imprint">
          {t("legalNotice")}
        </Link>
        <Link component={NextLink} href="/privacy">
          {t("privacy")}
        </Link>
        <Link component={NextLink} href="/terms">
          {t("terms")}
        </Link>
        <Link component={NextLink} href="/licenses">
          {t("licenses")}
        </Link>
      </Box>
      {credits.length > 0 && (
        <Box
          ref={creditsRef}
          data-testid="map-attributions"
          sx={{ ...barSx, marginLeft: "auto", textAlign: "right" }}
          // Entries are sanitized in `useMapAttributions` (anchors only, safe
          // hrefs) before they reach the registry.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: credits carry license-required publisher links
          dangerouslySetInnerHTML={{ __html: creditsHtml }}
        />
      )}
    </Box>
  );
}
