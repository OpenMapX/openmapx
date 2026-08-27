"use client";

import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { ComponentType } from "react";
import { lazy, Suspense, useMemo } from "react";
import { dedupeSharedMapLayers } from "./sharedIntegrationLayer";

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

export function MapLayerHost() {
  const registry = useIntegrationRegistry();

  const codeLayers = dedupeSharedMapLayers(
    registry.getWithMapLayer().filter((integration) => integration.isBuiltIn !== false),
  );

  if (codeLayers.length === 0) return null;

  return (
    <>
      {codeLayers.map((integration) => (
        <BuiltInMapLayer key={integration.id} id={integration.id} />
      ))}
    </>
  );
}
