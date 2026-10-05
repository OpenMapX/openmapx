"use client";

import Paper from "@mui/material/Paper";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { PANEL, useNavigationStore, useSidebarStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { lazy, type ReactNode, Suspense, useContext, useEffect, useState } from "react";
import { NAV_LANDSCAPE_PANEL_WIDTH, PANEL_WIDTH } from "@/lib/layout";
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
  const activeSidebarId = useSidebarStore((s) => s.activeSidebarId);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useMobilePanelHeightTracker("detail", el);
  const contextRailVisible =
    Boolean(activeSidebarId && activeSidebarId !== PANEL.PLACE) && !collapsed;
  // While navigating the card sits beside the guidance column instead; the
  // nav camera keeps its own framing, so it claims no map obstruction.
  const left = navigating ? NAV_LANDSCAPE_PANEL_WIDTH + 2 * CARD_GAP : PANEL_WIDTH + CARD_GAP;
  const top = navigating ? "calc(var(--omx-safe-top) + 16px)" : "66px";
  useMapObstruction(
    "detail",
    "left",
    contextRailVisible && !navigating ? left + DETAIL_CARD_WIDTH : null,
  );

  // The floating card belongs beside another visible rail. Collapsing that
  // rail hides its card temporarily; expanding restores both.
  if (!contextRailVisible && !navigating) return null;

  return (
    <Paper
      ref={setEl}
      elevation={6}
      sx={(theme) => ({
        position: "absolute",
        top,
        left,
        width: DETAIL_CARD_WIDTH,
        maxHeight: `calc(100dvh - ${top} - 12px)`,
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
