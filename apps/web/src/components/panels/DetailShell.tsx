"use client";

import Paper from "@mui/material/Paper";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useSidebarStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { lazy, type ReactNode, Suspense, useContext, useEffect, useState } from "react";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMapObstruction } from "@/lib/mapObstructions";
import { useMobilePanelHeightTracker } from "@/lib/mobilePanelHeight";
import { PLACE_DETENTS } from "./sheet/detents";
import { DetailChromeContext } from "./sheet/mobileSheetShared";

const MobileBottomSheet = lazy(() =>
  import("./sheet/MobileBottomSheet").then((m) => ({ default: m.MobileBottomSheet })),
);

const CARD_GAP = 24;
const DETAIL_CARD_WIDTH = 376;

// Re-exported so existing imports of `DetailChromeContext` from this module
// (tests included) keep working now that MobileBottomSheet owns the provider.
export { DetailChromeContext };

/** Registers a pinned header and/or docked footer for the mobile sheet host. */
export function useDetailChrome(header: ReactNode, footer: ReactNode) {
  const api = useContext(DetailChromeContext);
  useEffect(() => {
    api?.setHeader(header);
    return () => api?.setHeader(null);
  }, [api, header]);
  useEffect(() => {
    api?.setFooter(footer);
    return () => api?.setFooter(null);
  }, [api, footer]);
}

export function DetailShell({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const t = useTranslations("common");

  if (isMobile) {
    return (
      <Suspense fallback={null}>
        <MobileBottomSheet
          id="detail"
          zIndex={11}
          detents={PLACE_DETENTS}
          ariaLabel={t("detailsPanelAriaLabel")}
        >
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
  // The card floats beside the rail, so what it takes from the map is the
  // distance to its own right edge — which moves with the rail's collapse.
  useMapObstruction(
    "detail",
    "left",
    (collapsed ? CARD_GAP : PANEL_WIDTH + CARD_GAP) + DETAIL_CARD_WIDTH,
  );

  return (
    <Paper
      ref={setEl}
      elevation={6}
      sx={(theme) => ({
        position: "absolute",
        top: 66,
        left: collapsed ? CARD_GAP : PANEL_WIDTH + CARD_GAP,
        width: DETAIL_CARD_WIDTH,
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
