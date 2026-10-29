import type { IntegrationMetadata, LocaleStrings } from "@openmapx/core/api-contracts";

import type { CustomHealthCheckFn, Disclosure } from "./context";
import type { IntegrationHealthCheck, IntegrationManifest } from "./manifest";

export type { IntegrationsResponse } from "@openmapx/core/api-contracts";

export type IntegrationStrings = LocaleStrings;

export interface LoadedIntegration {
  id: string;
  manifest: IntegrationManifest;
  config: Record<string, unknown>;
  /** Host snapshot of this generation's resolved bindings; not part of public metadata. */
  resolvedServices?: Readonly<
    Record<string, Readonly<{ serviceId: string; url: string; enabled: boolean }>>
  >;
  directory: string;
  isBuiltIn: boolean;
  enabled: boolean;
  providers: Map<string, unknown[]>;
  strings: IntegrationStrings;
  customHealthCheck?: CustomHealthCheckFn;
  /**
   * True when a community directory ships backend/frontend code that the
   * host deliberately does not execute. Surfaced to the admin UI so the
   * deactivation is visible rather than a log line.
   */
  blockedCode?: boolean;
  disclosures?: Disclosure[];
  shutdownHandlers: Array<() => Promise<void>>;
}

export type LoadedIntegrationMeta = IntegrationMetadata;

export function toIntegrationMeta(integration: LoadedIntegration): LoadedIntegrationMeta {
  const en = integration.strings.en as Record<string, unknown> | undefined;
  return {
    id: integration.id,
    name: (en?.name as string) ?? integration.manifest.name ?? integration.id,
    description: (en?.description as string) ?? integration.manifest.description,
    enabled: integration.enabled,
    isBuiltIn: integration.isBuiltIn,
    domains: integration.manifest.domains,
    frontend: integration.manifest.frontend,
    dataSources: integration.manifest.dataSources,
    healthCheck:
      integration.manifest.healthCheck === undefined
        ? undefined
        : Array.isArray(integration.manifest.healthCheck)
          ? integration.manifest.healthCheck.map(publicHealthCheck)
          : publicHealthCheck(integration.manifest.healthCheck),
    strings: Object.keys(integration.strings).length > 0 ? integration.strings : undefined,
  };
}

function publicHealthCheck({ type, name, category }: IntegrationHealthCheck) {
  return { type, name, category };
}
