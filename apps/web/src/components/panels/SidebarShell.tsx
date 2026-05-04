"use client";

import Paper from "@mui/material/Paper";
import type { SxProps, Theme } from "@mui/material/styles";
import { useSidebarStore } from "@openmapx/core";
import type { ReactNode } from "react";
import { SidebarCollapseToggle } from "@/components/ui/SidebarCollapseToggle";
import { PANEL_WIDTH } from "@/lib/layout";

interface SidebarShellProps {
  children: ReactNode;
  /** Optional sx overrides merged onto the Paper (e.g. extra top padding). */
  contentSx?: SxProps<Theme>;
}

export function SidebarShell({ children, contentSx }: SidebarShellProps) {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggleCollapsed = useSidebarStore((s) => s.toggleCollapsed);

  return (
    <>
      <SidebarCollapseToggle collapsed={collapsed} onToggle={toggleCollapsed} />
      <Paper
        elevation={0}
        sx={[
          (theme) => ({
            position: "absolute",
            top: { xs: "auto", sm: 0 },
            bottom: { xs: 0, sm: "auto" },
            left: 0,
            right: { xs: 0, sm: "auto" },
            width: { xs: "100%", sm: PANEL_WIDTH },
            height: { xs: "auto", sm: "100dvh" },
            maxHeight: { xs: "60dvh", sm: "none" },
            // Light mode: keep the side rail on background.paper (#fff) —
            // light mode already looks correct flat.
            // Dark mode: switch to background.default (#1c1c1c) so the
            // floating DetailShell card on #2d2d2d visibly elevates off it.
            ...theme.applyStyles("dark", { bgcolor: "background.default" }),
            overflowY: "auto",
            borderRadius: { xs: "16px 16px 0 0", sm: 0 },
            boxShadow: { xs: 6, sm: "4px 0 12px var(--omx-shadow-soft)" },
            zIndex: 9,
            transform: { sm: collapsed ? "translateX(-100%)" : "translateX(0)" },
            transition: { sm: "transform 0.25s ease" },
          }),
          ...(Array.isArray(contentSx) ? contentSx : contentSx ? [contentSx] : []),
        ]}
      >
        {children}
      </Paper>
    </>
  );
}
