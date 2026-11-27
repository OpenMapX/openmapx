"use client";

import { useCapabilities } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useMemo } from "react";

/** A routing integration as the client sees it: its name and what it can serve. */
export interface RoutingEngine {
  id: string;
  name: string;
  available: boolean;
  modes: readonly string[];
  trafficProof: boolean;
  timeAware: boolean;
  exclusions: boolean;
}

/**
 * Every integration whose capabilities describe a routing engine, named from
 * the integration metadata. Behaviour is decided from these capabilities, so
 * an installed engine is treated like a built-in one.
 */
export function useRoutingEngines(): RoutingEngine[] {
  const { services } = useCapabilities();
  const registry = useIntegrationRegistry();
  return useMemo(
    () =>
      Object.entries(services).flatMap(([id, service]) =>
        service.modes === undefined
          ? []
          : [
              {
                id,
                name: registry.get(id)?.name ?? id,
                available: service.available,
                modes: service.modes,
                trafficProof: service.trafficProof === true,
                timeAware: service.timeAware === true,
                exclusions: service.exclusions === true,
              },
            ],
      ),
    [services, registry],
  );
}
