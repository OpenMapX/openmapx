/** Host-owned observations of successfully staged provider generations. */
import { createHmac, randomBytes } from "node:crypto";
import type { IntegrationRuntimeEvidence } from "@openmapx/core/api-contracts";
import { canonicalJson } from "@openmapx/core/ops";
import type { LoadedIntegration } from "@openmapx/integration-framework";

// An ephemeral keyed fingerprint prevents the administrative projection from
// becoming an offline oracle for low-entropy configuration or credential values.
const revisionKey = randomBytes(32);
const observations = new WeakMap<LoadedIntegration, IntegrationRuntimeEvidence>();
export const integrationConfigRevision = (config: Record<string, unknown>) =>
  createHmac("sha256", revisionKey).update(canonicalJson(config)).digest("hex");
export function stageIntegrationRuntimeEvidence(
  integration: LoadedIntegration,
  generationId: string,
): void {
  const bindings: Record<string, string | null> = {};
  for (const requirement of integration.manifest.requires ?? []) {
    const key = requirement.capability ?? requirement.service;
    if (key) bindings[key] = integration.resolvedServices?.[key]?.serviceId ?? null;
  }
  observations.set(integration, {
    generationId,
    bindings,
    configRevision: integrationConfigRevision(integration.config),
  });
}
export function integrationRuntimeEvidence(
  integration: LoadedIntegration | undefined,
): IntegrationRuntimeEvidence | null {
  if (!integration?.enabled || integration.blockedCode) return null;
  const value = observations.get(integration);
  return value ? structuredClone(value) : null;
}
