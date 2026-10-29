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
        {searchBarClearance !== "none" && (
          <SearchBarBand overlay={searchBarClearance === "content"} visible={scrolled} />
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

/**
 * The strip of the rail behind the floating search bar, pinned so content
 * scrolls beneath it rather than showing around the bar's edges. For a "shell"
 * panel it is also the spacer that holds the content below the bar. A
 * "content" panel lays out under the bar (a photo can fill the strip), so the
 * band overlays it and only fills in once the panel scrolls.
 */
function SearchBarBand({ overlay, visible }: { overlay: boolean; visible: boolean }) {
  return (
    <Box
      aria-hidden
      data-testid="search-bar-band"
      sx={{
        position: "sticky",
        top: 0,
        // Above the content's own sticky parts, such as the place tab strip.
        zIndex: 2,
        height: SEARCH_BAR_CLEARANCE,
        bgcolor: "inherit",
        ...(overlay && {
          mb: `calc(-1 * ${SEARCH_BAR_CLEARANCE})`,
          opacity: visible ? 1 : 0,
          transition: "opacity 0.15s",
          pointerEvents: visible ? "auto" : "none",
        }),
      }}
    />
  );
}
