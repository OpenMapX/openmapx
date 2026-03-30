"use client";

import { useIntegrationRegistry } from "@openmapx/core";
import { lazy, Suspense, useMemo } from "react";

function IntegrationMapLayer({ id }: { id: string }) {
  const LazyLayer = useMemo(
    () =>
      lazy(
        () =>
          import(
            /* webpackChunkName: "integration-[request]" */
            `@integrations/${id}/map-layer`
          ),
      ),
    [id],
  );

  return (
    <Suspense fallback={null}>
      <LazyLayer />
    </Suspense>
  );
}

export function MapLayerHost() {
  const registry = useIntegrationRegistry();
  const withMapLayer = registry.getWithMapLayer();

  if (withMapLayer.length === 0) return null;

  return (
    <>
      {withMapLayer.map((integration) => (
        <IntegrationMapLayer key={integration.id} id={integration.id} />
      ))}
    </>
  );
}
