"use client";

import { PANEL, useNavigationStore, useSidebarStore } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { ComponentType } from "react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { HideDuringNavigation } from "@/components/navigation/HideDuringNavigation";
import { DetailShell } from "./DetailShell";
import { DETAIL_PANELS, SIDEBAR_PANELS } from "./panel-map";
import { SidebarShell } from "./SidebarShell";

function resolveDefault(mod: Record<string, unknown>): { default: ComponentType } {
  const Component = (mod.default ??
    Object.values(mod).find((v) => typeof v === "function")) as ComponentType;
  return { default: Component };
}

const NullComponent = { default: (() => null) as ComponentType };

function BuiltInPanel({ id }: { id: string }) {
  const LazyPanel = useMemo(
    () =>
      lazy(() =>
        import(
          /* webpackChunkName: "integration-panel-[request]" */
          `@integrations/${id}/panel`
        )
          .then(resolveDefault)
          .catch(() => NullComponent),
      ),
    [id],
  );

  return (
    <Suspense fallback={null}>
      <LazyPanel />
    </Suspense>
  );
}

export function PanelHost() {
  const activeSidebarId = useSidebarStore((s) => s.activeSidebarId);
  const activeDetailId = useSidebarStore((s) => s.activeDetailId);
  const registry = useIntegrationRegistry();
  const withPanel = registry
    .getWithPanel()
    .filter((integration) => integration.isBuiltIn !== false);

  const navigating = useNavigationStore((s) => s.status !== "idle");
  // A card left open while planning must not pop up over the guidance. One
  // opened mid-route is re-opened through openDetail once guidance ends, so it
  // lands in whichever panel the restored layout gives it.
  const wasNavigating = useRef(navigating);
  useEffect(() => {
    if (wasNavigating.current === navigating) return;
    wasNavigating.current = navigating;
    const sidebar = useSidebarStore.getState();
    const placeCardOpen = sidebar.activeDetailId === PANEL.PLACE_CARD;
    sidebar.closeDetail();
    if (!navigating && placeCardOpen) sidebar.openDetail(PANEL.PLACE_CARD);
  }, [navigating]);

  const sidebarEntry = activeSidebarId ? SIDEBAR_PANELS[activeSidebarId] : null;
  const DetailContent = activeDetailId ? DETAIL_PANELS[activeDetailId] : null;

  return (
    <>
      {/* The route-planning sidebar is hidden during turn-by-turn navigation
          (both the desktop rail and the mobile bottom sheet), so the nav overlay
          owns the screen. It restores when navigation ends. */}
      <HideDuringNavigation>
        {sidebarEntry && (
          // Both panels sit side by side on desktop, but stack as bottom sheets
          // on mobile, where only the top one is reachable — so tell the lower
          // one to step aside while a detail panel is open.
          <SidebarShell
            contentSx={sidebarEntry.contentSx}
            detents={sidebarEntry.detents}
            obscured={Boolean(DetailContent)}
          >
            <Suspense fallback={null}>
              <sidebarEntry.component />
            </Suspense>
          </SidebarShell>
        )}
      </HideDuringNavigation>
      {/* A place tapped mid-route still opens its card over the nav overlay. */}
      {DetailContent && (
        <DetailShell>
          <Suspense fallback={null}>
            <DetailContent />
          </Suspense>
        </DetailShell>
      )}
      {withPanel.map((integration) => (
        <BuiltInPanel key={integration.id} id={integration.id} />
      ))}
    </>
  );
}
