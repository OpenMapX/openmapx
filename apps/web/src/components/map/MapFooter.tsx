"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useNavigationStore, useSidebarStore } from "@openmapx/core";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LAYER_SELECTOR_OPEN_EVENT } from "@/components/command-palette/constants";
import { AttributionDetails } from "@/components/ui/AttributionDetails";
import { AttributionNotices } from "@/components/ui/AttributionNotices";
import { useMapAttributionPresentation } from "@/integration-api/overlay/mapAttributionStore";
import { isPanelShiftActive, PANEL_WIDTH } from "@/lib/layout";
import {
  coversFooterCenter,
  MAP_FOOTER_OBSTRUCTION_ID,
  publishMapFooterCenterCovered,
} from "@/lib/mapFooterCenter";
import { useMeasuredMapObstruction } from "@/lib/mapObstructions";
import { CREDITS_SX } from "./MapCredits";
import { useMapFooterSurface } from "./useMapFooterSurface";

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
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down("sm"));
  const sidebarOpen = useSidebarStore((s) => s.activeSidebarId !== null);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const shifted = isPanelShiftActive({ sidebarOpen, sidebarCollapsed: collapsed, navigating });
  const credits = useMapAttributionPresentation();
  const creditsHtml = JSON.stringify(credits);

  const containerRef = useRef<HTMLElement>(null);
  const [footerEl, setFooterEl] = useState<HTMLElement | null>(null);
  const setFooterRef = useCallback((element: HTMLElement | null) => {
    containerRef.current = element;
    setFooterEl(element);
  }, []);
  const {
    container: portalContainer,
    setHome,
    docked,
    mapBudget,
  } = useMapFooterSurface(footerEl, mobile);
  useMeasuredMapObstruction(MAP_FOOTER_OBSTRUCTION_ID, "bottom", footerEl);
  const linksRef = useRef<HTMLDivElement>(null);
  const creditsRef = useRef<HTMLDivElement>(null);
  const mandatoryRef = useRef<HTMLSpanElement>(null);
  const [tall, setTall] = useState(false);
  const [merged, setMerged] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: credit changes resize the strip and (re)mount the element the observer watches
  useEffect(() => {
    const container = containerRef.current;
    const links = linksRef.current;
    if (!container || !links) return;
    const measure = () => {
      const creditsEl = creditsRef.current;
      const height = mandatoryRef.current?.getBoundingClientRect().height ?? 0;
      setTall(height > Math.max(1, mapBudget) * 0.25);
      const l = links.getBoundingClientRect();
      const c = creditsEl?.getBoundingClientRect();
      publishMapFooterCenterCovered(
        !docked && coversFooterCenter(container.getBoundingClientRect(), c ? [l, c] : [l]),
      );
      if (!c) {
        setMerged(false);
        return;
      }
      // Bars stretch to the same height within each flex row. Different
      // bottom edges therefore indicate that the groups wrapped onto separate rows.
      const sameLine = Math.abs(l.bottom - c.bottom) < 1;
      setMerged(!sameLine || c.left - l.right < MERGE_GAP);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    observer?.observe(links);
    if (creditsRef.current) observer?.observe(creditsRef.current);
    return () => {
      observer?.disconnect();
      publishMapFooterCenterCovered(false);
    };
  }, [creditsHtml, mapBudget, docked]);

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

  const footer = (
    <Box
      component="footer"
      ref={setFooterRef}
      sx={{
        bgcolor: merged ? background : "transparent",
        position: "absolute",
        bottom: {
          xs: "var(--omx-map-footer-bottom, var(--omx-safe-bottom))",
          sm: "var(--omx-safe-bottom)",
        },
        left: {
          xs: "var(--omx-safe-left)",
          sm: shifted ? `calc(${PANEL_WIDTH}px + var(--omx-safe-left))` : "var(--omx-safe-left)",
        },
        right: "var(--omx-safe-right)",
        zIndex: 5,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "stretch",
        justifyContent: "flex-start",
        columnGap: 0,
        rowGap: 0,
        // Only the two bars take pointer events; the empty space between them
        // stays a draggable part of the map.
        pointerEvents: "none",
        ...creditsTypography,
        transition: "left 0.25s ease",
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
        '[data-map-footer-surface="sheet"] > &': {
          position: "relative",
          bottom: "auto",
          left: "auto",
          right: "auto",
          marginLeft: "var(--omx-safe-left)",
          marginRight: "var(--omx-safe-right)",
          flexShrink: 0,
          transition: "none",
        },
      }}
    >
      <Box
        ref={linksRef}
        sx={{
          ...barSx,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          alignContent: "center",
          columnGap: "0.6em",
        }}
      >
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
      {credits.fullHtml.length > 0 && (
        <Box
          ref={creditsRef}
          data-testid="map-attributions"
          sx={{
            ...barSx,
            marginLeft: "auto",
            textAlign: "right",
            overflowWrap: "anywhere",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          <Box component="span" ref={mandatoryRef} data-testid="mandatory-map-attributions">
            <AttributionNotices notices={credits.visible} />
          </Box>
          {credits.visible.length > 0 && " | "}
          <AttributionDetails
            entries={credits.details}
            label={t("credits")}
            logos={credits.visible.flatMap((notice) => notice.logos)}
          />
          {tall && (
            <Box sx={{ mt: 0.5 }}>
              {t("manyRequiredCredits")}{" "}
              <Link
                component="button"
                type="button"
                onClick={() => window.dispatchEvent(new Event(LAYER_SELECTOR_OPEN_EVENT))}
                sx={{ font: "inherit", color: "inherit", cursor: "pointer" }}
              >
                {t("manageOverlays")}
              </Link>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
  return (
    <>
      <div ref={setHome} style={{ display: "contents" }} />
      {portalContainer && createPortal(footer, portalContainer)}
    </>
  );
}
