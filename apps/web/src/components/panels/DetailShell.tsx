"use client";

import Paper from "@mui/material/Paper";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useSidebarStore } from "@openmapx/core";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMobilePanelHeightTracker } from "@/lib/mobilePanelHeight";
import { PLACE_DETENTS } from "./sheet/detents";

const MobileBottomSheet = lazy(() =>
  import("./sheet/MobileBottomSheet").then((m) => ({ default: m.MobileBottomSheet })),
);

const CARD_GAP = 24;

interface DetailChromeApi {
  setHeader: (node: ReactNode) => void;
  setFooter: (node: ReactNode) => void;
}

// Content rendered as DetailShell's children can be several components deep
// (DetailShell -> lazy panel lookup -> the actual detail card), so there is no
// prop path from that content back up to the sheet's pinned header / docked
// footer slots. This context gives it one. Outside a mobile sheet (desktop,
// where everything renders inline) the context has no provider, so
// useDetailChrome is a no-op.
//
// Exported so tests can provide a stub DetailChromeApi and observe what
// consumers register, without needing a full MobileBottomSheet host.
export const DetailChromeContext = createContext<DetailChromeApi | null>(null);

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
  const [header, setHeader] = useState<ReactNode>(null);
  const [footer, setFooter] = useState<ReactNode>(null);
  const chromeApi = useMemo<DetailChromeApi>(() => ({ setHeader, setFooter }), []);

  if (isMobile) {
    return (
      <DetailChromeContext.Provider value={chromeApi}>
        <Suspense fallback={null}>
          <MobileBottomSheet
            id="detail"
            zIndex={11}
            detents={PLACE_DETENTS}
            header={header}
            footer={footer}
          >
            {children}
          </MobileBottomSheet>
        </Suspense>
      </DetailChromeContext.Provider>
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
