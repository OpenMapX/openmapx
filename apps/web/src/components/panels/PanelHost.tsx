"use client";

import { useSidebarStore } from "@openmapx/core";
import { getCommunityModule } from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { ComponentType } from "react";
import { lazy, Suspense, useMemo } from "react";
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

function CommunityPanel({ id }: { id: string }) {
  const mod = getCommunityModule(id);
  if (!mod?.panel) return null;
  const Component = mod.panel;
  return <Component />;
}

export function PanelHost() {
  const activeSidebarId = useSidebarStore((s) => s.activeSidebarId);
  const activeDetailId = useSidebarStore((s) => s.activeDetailId);
  const registry = useIntegrationRegistry();
  const withPanel = registry.getWithPanel();

  const sidebarEntry = activeSidebarId ? SIDEBAR_PANELS[activeSidebarId] : null;
  const DetailContent = activeDetailId ? DETAIL_PANELS[activeDetailId] : null;

  return (
    <>
      {/* The route-planning sidebar / place detail are hidden during turn-by-turn
          navigation (both the desktop rail and the mobile bottom sheet), so the
          nav overlay owns the screen. They restore when navigation ends. */}
      <HideDuringNavigation>
        {sidebarEntry && (
          <SidebarShell contentSx={sidebarEntry.contentSx}>
            <sidebarEntry.component />
          </SidebarShell>
        )}
        {DetailContent && (
          <DetailShell>
            <DetailContent />
          </DetailShell>
        )}
      </HideDuringNavigation>
      {withPanel.map((integration) => {
        const isCommunity = getCommunityModule(integration.id) !== undefined;
        return isCommunity ? (
          <CommunityPanel key={integration.id} id={integration.id} />
        ) : (
          <BuiltInPanel key={integration.id} id={integration.id} />
        );
      })}
    </>
  );
}
