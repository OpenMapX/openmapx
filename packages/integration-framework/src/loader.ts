import type { LocaleStrings } from "../strings/index";
import type { CustomHealthCheckFn, Disclosure } from "./context";
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
  /**
   * True when a community directory ships backend/frontend code that the
   * host deliberately does not execute. Surfaced to the admin UI so the
   * deactivation is visible rather than a log line.
   */
  blockedCode?: boolean;
  disclosures?: Disclosure[];
  shutdownHandlers: Array<() => Promise<void>>;
}

export interface LoadedIntegrationMeta {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  domains: string[];
  frontend?: IntegrationManifest["frontend"];
  dataSources?: IntegrationManifest["dataSources"];
  healthCheck?: IntegrationManifest["healthCheck"];
  strings?: IntegrationStrings;
  /**
   * False for declarative community integrations loaded from
   * `custom_integrations/`, true/undefined for trusted built-ins. Community
   * runtime components stay absent until a separate isolation boundary exists.
   */
  isBuiltIn?: boolean;
}

/**
 * Wire shape of the `/api/integrations` orchestrator response. The host
 * returns the enabled integrations alongside the framework's shared strings
 * catalog (locale-keyed) so clients can resolve `shared.*` i18n tokens
 * without a separate fetch.
 */
export interface IntegrationsResponse {
  /** SHA-256 revision of the complete runtime metadata payload. */
  revision: string;
  integrations: Array<LoadedIntegrationMeta & { isBuiltIn?: boolean }>;
  frameworkStrings: LocaleStrings;
  disclosures: Disclosure[];
}

export function toIntegrationMeta(integration: LoadedIntegration): LoadedIntegrationMeta {
  const en = integration.strings.en as Record<string, unknown> | undefined;
  return {
    id: integration.id,
    name: (en?.name as string) ?? integration.manifest.name ?? integration.id,
    description: (en?.description as string) ?? integration.manifest.description,
    enabled: integration.enabled,
    domains: integration.manifest.domains,
    frontend: integration.manifest.frontend,
    dataSources: integration.manifest.dataSources,
    healthCheck: integration.manifest.healthCheck,
    strings: Object.keys(integration.strings).length > 0 ? integration.strings : undefined,
  };
}
