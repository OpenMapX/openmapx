import type { CustomHealthCheckFn } from "./context";
import type { IntegrationManifest } from "./manifest";

export interface LoadedIntegration {
  id: string;
  manifest: IntegrationManifest;
  config: Record<string, unknown>;
  directory: string;
  isBuiltIn: boolean;
  enabled: boolean;
  providers: Map<string, unknown[]>;
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
}

export function toIntegrationMeta(integration: LoadedIntegration): LoadedIntegrationMeta {
  const envVars = integration.manifest.envVars;
  const configured =
    !envVars?.length ||
    envVars.every((v) => {
      const val = process.env[v];
      return val !== undefined && val !== "";
    });

  return {
    id: integration.id,
    name: integration.manifest.name,
    description: integration.manifest.description,
    enabled: integration.enabled,
    configured,
    domains: integration.manifest.domains,
    frontend: integration.manifest.frontend,
    attribution: integration.manifest.attribution,
    privacy: integration.manifest.privacy,
    healthCheck: integration.manifest.healthCheck,
  };
}
