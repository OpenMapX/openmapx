import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import {
  type I18nToken,
  isI18nToken,
  resolveToken,
  type Translatable,
} from "@openmapx/integration-framework/strings";
import { useLocale } from "next-intl";
import { useCallback } from "react";
import { useFrameworkStrings } from "@/lib/frameworkStringsContext";

/**
 * Resolver hook for translating `I18nToken` payloads emitted by the
 * data-source contract. The returned function accepts either a token (looked
 * up in the integration's strings, then the framework shared catalog) or a
 * raw `string | number` (returned verbatim).
 *
 * @param integrationId The integration that emitted the token — used to scope
 *   the integration catalog lookup. Typically `detail.sources[0]` or the
 *   domain id resolved by `pickIntegrationForSources`.
 */
export function useDataSourceI18nResolver(
  integrationId: string | undefined,
): (value: Translatable | undefined) => string {
  const locale = useLocale();
  const registry = useIntegrationRegistry();
  const frameworkStrings = useFrameworkStrings();

  return useCallback(
    (value: Translatable | undefined): string => {
      if (value === undefined || value === null) return "";
      if (typeof value === "number") return String(value);
      if (typeof value === "string") return value;
      if (!isI18nToken(value)) return String(value);
      const integration = integrationId ? registry.get(integrationId) : undefined;
      return resolveToken(value as I18nToken, {
        locale,
        fallbackLocale: "en",
        shared: frameworkStrings,
        integration: integration?.strings,
      });
    },
    [locale, registry, frameworkStrings, integrationId],
  );
}
