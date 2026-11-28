import type { IntegrationMetadata, LocaleStrings } from "@openmapx/core/api-contracts";

import type { CustomHealthCheckFn, Disclosure } from "./context";
import type { IntegrationHealthCheck, IntegrationManifest } from "./manifest";

export type { IntegrationsResponse } from "@openmapx/core/api-contracts";

export type IntegrationStrings = LocaleStrings;

export type IntegrationLoadState = "loaded" | "disabled" | "incompatible" | "failed" | "safe-mode";

export interface IntegrationLoadError {
  /**
   * The step at which loading stopped. `platform` means the host could not
   * try the integration's code at all (its extension state could not be read,
   * or the reload after leaving safe mode failed), so nothing points at it.
   */
  phase: "import" | "migrate" | "setup" | "deadline" | "platform";
  message: string;
}

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
   * How this generation's load of the integration ended. Surfaced to the
   * admin UI so an integration left out is visible rather than a log line.
   */
  loadState: IntegrationLoadState;
  /**
   * Why the code did not load; present only when `loadState` is `"failed"`,
   * or `"incompatible"` with the version the integration needs.
   */
  loadError?: IntegrationLoadError;
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
