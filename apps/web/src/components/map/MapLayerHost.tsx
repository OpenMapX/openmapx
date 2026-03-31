"use client";

import { getCommunityModule, useIntegrationRegistry } from "@openmapx/core";
import type { ComponentType } from "react";
import { lazy, Suspense, useMemo } from "react";

function resolveDefault(mod: Record<string, unknown>): { default: ComponentType } {
  const Component = (mod.default ??
    Object.values(mod).find((v) => typeof v === "function")) as ComponentType;
  return { default: Component };
}

function BuiltInMapLayer({ id }: { id: string }) {
  const LazyLayer = useMemo(
    () =>
      lazy(() =>
        import(
          /* webpackChunkName: "integration-[request]" */
          `@integrations/${id}/map-layer`
        ).then(resolveDefault),
      ),
    [id],
  );

  return (
    <Suspense fallback={null}>
      <LazyLayer />
    </Suspense>
  );
}

function CommunityMapLayer({ id }: { id: string }) {
  const mod = getCommunityModule(id);
  if (!mod?.mapLayer) return null;
  const Component = mod.mapLayer;
  return <Component />;
}

export function MapLayerHost() {
  const registry = useIntegrationRegistry();
  const withMapLayer = registry.getWithMapLayer();

  if (withMapLayer.length === 0) return null;

  return (
    <>
      {withMapLayer.map((integration) => {
        const isCommunity = getCommunityModule(integration.id) !== undefined;
        return isCommunity ? (
          <CommunityMapLayer key={integration.id} id={integration.id} />
        ) : (
          <BuiltInMapLayer key={integration.id} id={integration.id} />
        );
      })}
    </>
  );
}
