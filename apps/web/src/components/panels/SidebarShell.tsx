"use client";

import Paper from "@mui/material/Paper";
import type { SxProps, Theme } from "@mui/material/styles";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useSidebarStore } from "@openmapx/core";
import { type ReactNode, useState } from "react";
import { SidebarCollapseToggle } from "@/components/ui/SidebarCollapseToggle";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMobilePanelHeightTracker } from "@/lib/mobilePanelHeight";
import { MobileBottomSheet } from "./MobileBottomSheet";

interface SidebarShellProps {
  children: ReactNode;
  /** Optional sx overrides merged onto the Paper (e.g. extra top padding). */
  contentSx?: SxProps<Theme>;
}

export function SidebarShell({ children, contentSx }: SidebarShellProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));

  if (isMobile) {
    return (
      <MobileBottomSheet id="sidebar" zIndex={11} contentSx={contentSx}>
        {children}
      </MobileBottomSheet>
    );
  }
  return <DesktopSidebar contentSx={contentSx}>{children}</DesktopSidebar>;
}

function DesktopSidebar({ children, contentSx }: SidebarShellProps) {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useMobilePanelHeightTracker("sidebar", el);

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
