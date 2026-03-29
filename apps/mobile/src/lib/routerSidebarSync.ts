import { PANEL, useSidebarStore } from "@openmapx/core";
import { usePathname } from "expo-router";
import { useEffect } from "react";

/**
 * Syncs the current Expo Router pathname to the shared sidebar store
 * so that hooks reading `activeSidebarId` work on mobile.
 */
export function useRouterSidebarSync(): void {
  const pathname = usePathname();
  const openSidebar = useSidebarStore((s) => s.openSidebar);
  const closeSidebar = useSidebarStore((s) => s.closeSidebar);

  useEffect(() => {
    if (pathname.startsWith("/place/")) {
      openSidebar(PANEL.PLACE);
    } else if (pathname.startsWith("/directions")) {
      openSidebar(PANEL.DIRECTIONS);
    } else if (pathname.startsWith("/category/")) {
      openSidebar(PANEL.CATEGORY);
    } else if (pathname.startsWith("/datasource/")) {
      openSidebar(PANEL.DATASOURCE);
    } else if (pathname.startsWith("/saved")) {
      openSidebar(PANEL.SAVED);
    } else if (pathname.startsWith("/transit/")) {
      openSidebar(PANEL.PLACE);
    } else {
      closeSidebar();
    }
  }, [pathname, openSidebar, closeSidebar]);
}
