"use client";

import Paper from "@mui/material/Paper";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useSidebarStore } from "@openmapx/core";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMobilePanelHeightTracker } from "@/lib/mobilePanelHeight";

const MobileBottomSheet = lazy(() =>
  import("./MobileBottomSheet").then((m) => ({ default: m.MobileBottomSheet })),
);

const CARD_GAP = 24;

export function DetailShell({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));

  if (isMobile) {
    return (
      <Suspense fallback={null}>
        <MobileBottomSheet id="detail" zIndex={11}>
          {children}
        </MobileBottomSheet>
      </Suspense>
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
      sx={(theme) => ({
        position: "absolute",
        top: 66,
        left: collapsed ? CARD_GAP : PANEL_WIDTH + CARD_GAP,
        width: 376,
        maxHeight: "calc(100dvh - 78px)",
        overflowY: "auto",
        borderRadius: 2,
        zIndex: 10,
        transition: "left 0.25s ease",
        // Match SidebarShell in dark mode (background.default, #1c1c1c) so
        // the floating card uses the same surface as the side rail. The
        // elevation={6} shadow still provides visual separation. Light
        // mode is unchanged — both surfaces are background.paper there.
        //
        // backgroundImage: "none" disables MUI's dark-mode elevation
        // overlay (a translucent white gradient Paper adds at elevation>0
        // to communicate lift); without this override the bgcolor would
        // be lifted above #1c1c1c and visibly differ from SidebarShell.
        ...theme.applyStyles("dark", {
          bgcolor: "background.default",
          backgroundImage: "none",
        }),
      })}
    >
      {children}
    </Paper>
  );
}
