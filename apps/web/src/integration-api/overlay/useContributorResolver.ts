"use client";

import {
  type ContributorEvidence,
  dataSourceToAttribution,
  resolveContributors,
} from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useCallback } from "react";

/** Capture a record's receipt before it is cached or sent to the map worker. */
export function useContributorResolver() {
  const registry = useIntegrationRegistry();
  return useCallback(
    (evidence: ContributorEvidence) =>
      resolveContributors(evidence, (sourceId) => {
        const source = registry.findDataSource(sourceId);
        return source ? dataSourceToAttribution(source) : undefined;
      }),
    [registry],
  );
}
