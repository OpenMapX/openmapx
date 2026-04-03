import type { CustomHealthCheckFn } from "./context";
import type { IntegrationManifest } from "./manifest";

export type IntegrationStrings = Record<string, Record<string, unknown>>;

export interface LoadedIntegration {
  id: string;
  manifest: IntegrationManifest;
  config: Record<string, unknown>;
  directory: string;
  isBuiltIn: boolean;
  enabled: boolean;
  providers: Map<string, unknown[]>;
  strings: IntegrationStrings;
  customHealthCheck?: CustomHealthCheckFn;
  shutdownHandlers: Array<() => Promise<void>>;
}

export interface LoadedIntegrationMeta {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  configured: boolean;
  domains: string[];
  frontend?: IntegrationManifest["frontend"];
  attribution?: IntegrationManifest["attribution"];
  privacy?: IntegrationManifest["privacy"];
  healthCheck?: IntegrationManifest["healthCheck"];
  strings?: IntegrationStrings;
}

export function toIntegrationMeta(integration: LoadedIntegration): LoadedIntegrationMeta {
  const envVars = integration.manifest.envVars;
  const configured =
    !envVars?.length ||
    envVars.every((v) => {
      const val = process.env[v];
      return val !== undefined && val !== "";
    });

  const en = integration.strings.en as Record<string, unknown> | undefined;
  return {
    id: integration.id,
    name: (en?.name as string) ?? integration.manifest.name ?? integration.id,
    description: (en?.description as string) ?? integration.manifest.description,
    enabled: integration.enabled,
    configured,
    domains: integration.manifest.domains,
    frontend: integration.manifest.frontend,
    attribution: integration.manifest.attribution,
    privacy: integration.manifest.privacy,
    healthCheck: integration.manifest.healthCheck,
    strings: Object.keys(integration.strings).length > 0 ? integration.strings : undefined,
  };
}
