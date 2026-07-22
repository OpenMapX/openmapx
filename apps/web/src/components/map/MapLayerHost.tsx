"use client";

import { getCommunityModule } from "@openmapx/integration-framework";
import {
  useCommunityModulesVersion,
  useIntegrationRegistry,
} from "@openmapx/integration-framework/react";
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

function CommunityMapLayer({ id }: { id: string }) {
  const mod = getCommunityModule(id);
  if (!mod?.mapLayer) return null;
  const Component = mod.mapLayer;
  return <Component />;
}

export function MapLayerHost() {
  const registry = useIntegrationRegistry();
  // Re-render when a community bundle registers its map layer after first paint.
  useCommunityModulesVersion();

  // Every map overlay renders from integration code (`map-layer.tsx`): built-in
  // overlays via a static import, community ones via their runtime bundle.
  const codeLayers = dedupeSharedMapLayers(registry.getWithMapLayer());

  if (codeLayers.length === 0) return null;

  return (
    <>
      {codeLayers.map((integration) => {
        // Community integrations (loaded from custom_integrations/) render via the
        // bundle path — keyed off `isBuiltIn`, not on whether the bundle has
        // registered yet, so the brief pre-load window doesn't fall through to a
        // non-existent `@integrations/<id>/map-layer` built-in import.
        const isCommunity =
          integration.isBuiltIn === false || getCommunityModule(integration.id) !== undefined;
        return isCommunity ? (
          <CommunityMapLayer key={integration.id} id={integration.id} />
        ) : (
          <BuiltInMapLayer key={integration.id} id={integration.id} />
        );
      })}
    </>
  );
}
