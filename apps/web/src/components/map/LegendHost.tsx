"use client";

import { useIntegrationRegistry } from "@openmapx/core";
import type { ComponentType } from "react";
import { lazy, Suspense, useMemo } from "react";

function resolveDefault(mod: Record<string, unknown>): { default: ComponentType } {
  const Component = (mod.default ??
    Object.values(mod).find((v) => typeof v === "function")) as ComponentType;
  return { default: Component };
}

function IntegrationLegend({ id }: { id: string }) {
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

export function LegendHost() {
  const registry = useIntegrationRegistry();
  const withLegend = registry.getWithLegend();

  if (withLegend.length === 0) return null;

  return (
    <>
      {withLegend.map((integration) => (
        <IntegrationLegend key={integration.id} id={integration.id} />
      ))}
    </>
  );
}
