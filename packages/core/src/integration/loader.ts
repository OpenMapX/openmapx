import type { CustomHealthCheckFn } from "./context";
import type { IntegrationManifest } from "./manifest";
import { normalizeEnvVars } from "./manifest";

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
  dataSources?: IntegrationManifest["dataSources"];
  healthCheck?: IntegrationManifest["healthCheck"];
  strings?: IntegrationStrings;
}

export function toIntegrationMeta(integration: LoadedIntegration): LoadedIntegrationMeta {
  // Only required env vars gate `configured`. Optional overrides don't block the UI.
  const required = normalizeEnvVars(integration.manifest.envVars).filter((v) => v.required);
  const configured =
    required.length === 0 ||
    required.every((v) => {
      const val = process.env[v.name];
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
    dataSources: integration.manifest.dataSources,
    healthCheck: integration.manifest.healthCheck,
    strings: Object.keys(integration.strings).length > 0 ? integration.strings : undefined,
  };
}
