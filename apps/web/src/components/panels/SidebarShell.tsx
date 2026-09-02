"use client";

import Paper from "@mui/material/Paper";
import type { SxProps, Theme } from "@mui/material/styles";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useSidebarStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { SidebarCollapseToggle } from "@/components/ui/SidebarCollapseToggle";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMapObstruction } from "@/lib/mapObstructions";
import { useMobilePanelHeightTracker } from "@/lib/mobilePanelHeight";
import { type DetentConfig, LIST_DETENTS } from "./sheet/detents";

const MobileBottomSheet = lazy(() =>
  import("./sheet/MobileBottomSheet").then((m) => ({ default: m.MobileBottomSheet })),
);

interface SidebarShellProps {
  children: ReactNode;
  /** Optional sx overrides merged onto the Paper (e.g. extra top padding). */
  contentSx?: SxProps<Theme>;
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
  contentSx,
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
          contentSx={contentSx}
          obscured={obscured}
          ariaLabel={t("resultsPanelAriaLabel")}
        >
          {children}
        </MobileBottomSheet>
      </Suspense>
    );
  }
  return <DesktopSidebar contentSx={contentSx}>{children}</DesktopSidebar>;
}

function DesktopSidebar({ children, contentSx }: SidebarShellProps) {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useMobilePanelHeightTracker("sidebar", el);
  useMapObstruction("sidebar", "left", collapsed ? null : PANEL_WIDTH);

  return (
    <>
      <SidebarCollapseToggle collapsed={collapsed} onToggle={toggleCollapsed} />
      <Paper
        ref={setEl}
        elevation={0}
        sx={[
          (theme) => ({
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
          }),
          ...(Array.isArray(contentSx) ? contentSx : contentSx ? [contentSx] : []),
        ]}
      >
        {children}
      </Paper>
    </>
  );
}
