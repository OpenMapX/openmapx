"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useSidebarStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { SidebarCollapseToggle } from "@/components/ui/SidebarCollapseToggle";
import { PANEL_WIDTH, SEARCH_BAR_CLEARANCE } from "@/lib/layout";
import { useMapObstruction } from "@/lib/mapObstructions";
import { useMobilePanelHeightTracker } from "@/lib/mobilePanelHeight";
import { type SearchBarClearance, SearchBarClearanceContext } from "./searchBarClearance";
import { type DetentConfig, LIST_DETENTS } from "./sheet/detents";

const MobileBottomSheet = lazy(() =>
  import("./sheet/MobileBottomSheet").then((m) => ({ default: m.MobileBottomSheet })),
);

interface SidebarShellProps {
  children: ReactNode;
  /** How the content stays clear of the floating search bar on desktop. Defaults to "shell". */
  searchBarClearance?: SearchBarClearance;
  /** Mobile sheet detents for the surface rendered inside. Defaults to LIST_DETENTS. */
  detents?: DetentConfig;
  /**
   * A detail panel is stacked on top. Mobile shows one sheet at a time, so this
   * one steps aside; desktop shows the rail and the detail card together and
   * never sets it.
   */
  obscured?: boolean;
}

export function SidebarShell({
  children,
  searchBarClearance = "shell",
  detents = LIST_DETENTS,
  obscured,
}: SidebarShellProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const t = useTranslations("common");

  if (isMobile) {
    return (
      <Suspense fallback={null}>
        <MobileBottomSheet
          id="sidebar"
          zIndex={11}
          detents={detents}
          obscured={obscured}
          ariaLabel={t("resultsPanelAriaLabel")}
        >
          {children}
        </MobileBottomSheet>
      </Suspense>
    );
  }
  return <DesktopSidebar searchBarClearance={searchBarClearance}>{children}</DesktopSidebar>;
}

function DesktopSidebar({
  children,
  searchBarClearance,
}: {
  children: ReactNode;
  searchBarClearance: SearchBarClearance;
}) {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  useMobilePanelHeightTracker("sidebar", el);
  useMapObstruction("sidebar", "left", collapsed ? null : PANEL_WIDTH);

  return (
    <>
      <SidebarCollapseToggle collapsed={collapsed} onToggle={toggleCollapsed} />
      <Paper
        ref={setEl}
        elevation={0}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        sx={(theme) => ({
          position: "absolute",
          top: 0,
          left: 0,
          width: PANEL_WIDTH,
          height: "100dvh",
          // Light mode: keep the side rail on background.paper (#fff) —
          // light mode already looks correct flat.
          // Dark mode: switch to background.default (#1c1c1c) so the
          // floating DetailShell card on #2d2d2d visibly elevates off it.
          ...theme.applyStyles("dark", { bgcolor: "background.default" }),
          overflowY: "auto",
          borderRadius: 0,
          boxShadow: "4px 0 12px var(--omx-shadow-soft)",
          zIndex: 9,
          transform: collapsed ? "translateX(-100%)" : "translateX(0)",
          transition: "transform 0.25s ease",
        })}
      >
        {searchBarClearance !== "none" && <SearchBarFade visible={scrolled} />}
        {searchBarClearance === "shell" && (
          <Box aria-hidden sx={{ height: SEARCH_BAR_CLEARANCE }} />
        )}
        <SearchBarClearanceContext.Provider
          value={searchBarClearance === "content" ? SEARCH_BAR_CLEARANCE : null}
        >
          {children}
        </SearchBarClearanceContext.Provider>
      </Paper>
    </>
  );
}

/** How far below the reserved strip scrolled content takes to fade out. */
const FADE_LENGTH = 24;

/**
 * A pinned wash of the rail's background behind the floating search bar, so
 * content scrolling up dissolves beneath the bar instead of showing around its
 * edges or being cut at a hard line. Solid through the reserved strip, so
 * nothing peeks out between the bar and a header pinned below it (the place
 * tabs), then fading out. It only appears once the rail scrolls, so a photo
 * laid out under the bar stays fully visible at rest.
 */
function SearchBarFade({ visible }: { visible: boolean }) {
  const height = `calc(${SEARCH_BAR_CLEARANCE} + ${FADE_LENGTH}px)`;
  const fade = (color: string) =>
    `linear-gradient(to bottom, ${color} calc(100% - ${FADE_LENGTH}px), transparent)`;
  return (
    <Box
      aria-hidden
      data-testid="search-bar-fade"
      sx={(theme) => ({
        position: "sticky",
        top: 0,
        // Under sticky parts that come later with the same z-index, such as the
        // place tab strip, which pins over the fading part and stays crisp.
        zIndex: 1,
        height,
        mb: `calc(-1 * ${height})`,
        background: fade((theme.vars ?? theme).palette.background.paper),
        ...theme.applyStyles("dark", {
          background: fade((theme.vars ?? theme).palette.background.default),
        }),
        opacity: visible ? 1 : 0,
        transition: "opacity 0.15s",
        pointerEvents: "none",
      })}
    />
  );
}
