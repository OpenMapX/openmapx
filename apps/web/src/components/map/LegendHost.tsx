"use client";

import { getCommunityModule, useIntegrationRegistry } from "@openmapx/core";
import type { ComponentType } from "react";
import { lazy, Suspense, useMemo } from "react";

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
  const withLegend = registry.getWithLegend();

  if (withLegend.length === 0) return null;

  return (
    <>
      {withLegend.map((integration) => {
        const isCommunity = getCommunityModule(integration.id) !== undefined;
        return isCommunity ? (
          <CommunityLegend key={integration.id} id={integration.id} />
        ) : (
          <BuiltInLegend key={integration.id} id={integration.id} />
        );
      })}
    </>
  );
}
