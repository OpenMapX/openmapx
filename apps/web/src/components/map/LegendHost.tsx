"use client";

import { getCommunityModule } from "@openmapx/integration-framework";
import {
  useCommunityModulesVersion,
  useIntegrationRegistry,
} from "@openmapx/integration-framework/react";
import type { ComponentType } from "react";
import { lazy, Suspense, useMemo } from "react";
import { DeclarativeLegend } from "./overlay/DeclarativeLegend";

function resolveDefault(mod: Record<string, unknown>): { default: ComponentType } {
  const Component = (mod.default ??
    Object.values(mod).find((v) => typeof v === "function")) as ComponentType;
  return { default: Component };
}

function BuiltInLegend({ id }: { id: string }) {
  const LazyLegend = useMemo(
    () =>
      lazy(() =>
        import(
          /* webpackChunkName: "integration-legend-[request]" */
          `@integrations/${id}/legend`
        ).then(resolveDefault),
      ),
    [id],
  );

  return (
    <Suspense fallback={null}>
      <LazyLegend />
    </Suspense>
  );
}

function CommunityLegend({ id }: { id: string }) {
  const mod = getCommunityModule(id);
  if (!mod?.legend) return null;
  const Component = mod.legend;
  return <Component />;
}

export function LegendHost() {
  const registry = useIntegrationRegistry();
  // Re-render when a community bundle registers its legend after first paint.
  useCommunityModulesVersion();

  // Declarative legends (manifest `frontend.overlay.legend` data) are rendered by
  // the host; they take precedence over the code legend path.
  const declarative = registry.getAll().filter((i) => i.enabled && i.frontend?.overlay?.legend);
  const declarativeIds = new Set(declarative.map((i) => i.id));
  const codeLegends = registry.getWithLegend().filter((i) => !declarativeIds.has(i.id));

  if (declarative.length === 0 && codeLegends.length === 0) return null;

  return (
    <>
      {declarative.map((integration) => (
        <DeclarativeLegend key={integration.id} integration={integration} />
      ))}
      {codeLegends.map((integration) => {
        const isCommunity =
          integration.isBuiltIn === false || getCommunityModule(integration.id) !== undefined;
        return isCommunity ? (
          <CommunityLegend key={integration.id} id={integration.id} />
        ) : (
          <BuiltInLegend key={integration.id} id={integration.id} />
        );
      })}
    </>
  );
}
