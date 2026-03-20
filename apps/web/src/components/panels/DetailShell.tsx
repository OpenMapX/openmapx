"use client";

import Paper from "@mui/material/Paper";
import { useSidebarStore } from "@openmapx/core";
import type { ReactNode } from "react";
import { PANEL_WIDTH } from "@/lib/layout";

const CARD_GAP = 24;

export function DetailShell({ children }: { children: ReactNode }) {
  const collapsed = useSidebarStore((s) => s.collapsed);

  return (
    <Paper
      elevation={6}
      sx={{
        position: "absolute",
        top: { xs: "auto", sm: 66 },
        bottom: { xs: 0, sm: "auto" },
        left: { xs: 0, sm: collapsed ? CARD_GAP : PANEL_WIDTH + CARD_GAP },
        right: { xs: 0, sm: "auto" },
        width: { xs: "100%", sm: 376 },
        maxHeight: { xs: "65dvh", sm: "calc(100dvh - 78px)" },
        overflowY: "auto",
        borderRadius: { xs: "16px 16px 0 0", sm: 2 },
        zIndex: 10,
        transition: { sm: "left 0.25s ease" },
      }}
    >
      {children}
    </Paper>
  );
}
