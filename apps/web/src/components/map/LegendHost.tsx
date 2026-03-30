"use client";

import { useIntegrationRegistry } from "@openmapx/core";
import { lazy, Suspense, useMemo } from "react";

function IntegrationLegend({ id }: { id: string }) {
  const LazyLegend = useMemo(
    () =>
      lazy(
        () =>
          import(
            /* webpackChunkName: "integration-legend-[request]" */
            `@integrations/${id}/legend`
          ),
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
