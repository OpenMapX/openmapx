"use client";

import Paper from "@mui/material/Paper";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useSidebarStore } from "@openmapx/core";
import { type ReactNode, useState } from "react";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMobilePanelHeightTracker } from "@/lib/mobilePanelHeight";
import { MobileBottomSheet } from "./MobileBottomSheet";

const CARD_GAP = 24;

export function DetailShell({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));

  if (isMobile) {
    return (
      <MobileBottomSheet id="detail" zIndex={11}>
        {children}
      </MobileBottomSheet>
    );
  }
  return <DesktopDetail>{children}</DesktopDetail>;
}

function DesktopDetail({ children }: { children: ReactNode }) {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useMobilePanelHeightTracker("detail", el);

  return (
    <Paper
      ref={setEl}
      elevation={6}
      sx={{
        position: "absolute",
        top: 66,
        left: collapsed ? CARD_GAP : PANEL_WIDTH + CARD_GAP,
        width: 376,
        maxHeight: "calc(100dvh - 78px)",
        overflowY: "auto",
        borderRadius: 2,
        zIndex: 10,
        transition: "left 0.25s ease",
      }}
    >
      {children}
    </Paper>
  );
}
