"use client";

import type {
  AdminIntegrationResolvedConfig,
  ConfigurationOwnership,
} from "@openmapx/core/api-contracts";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useIntegrationAdmin } from "@/lib/admin/integrationAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { SchemaConfigForm } from "../shared/SchemaConfigForm";

const excludedKeys = ["enabled"];

interface ConfigSchemaFormProps {
  integrationId: string;
  /** Keys another control on the page edits, beside `enabled`. */
  excludeKeys?: readonly string[];
  /** The manifest configSchema object. */
  schema: Record<string, unknown> | undefined;
  /** Resolved config values with source annotations. */
  resolvedConfig: AdminIntegrationResolvedConfig;
  ownership?: Record<string, ConfigurationOwnership>;
  /** Called after a successful save + reload. */
  onSaved?: () => void;
}

/**
 * Integration config tab — a thin wrapper over the shared {@link SchemaConfigForm}.
 * Integration-specific bits: the save is a `PATCH …/config` that reloads the
 * integration, and the `enabled` flag is owned by a dedicated toggle elsewhere
 * so it's excluded here. Secrets are never shown — they live on the Credentials
 * tab.
 */
export function ConfigSchemaForm({
  integrationId,
  excludeKeys,
  schema,
  resolvedConfig,
  ownership,
  onSaved,
}: ConfigSchemaFormProps) {
  const t = useTranslations("adminIntegrations");
  const admin = useIntegrationAdmin();
  const owner = useAdminMutationOwner(admin.client, integrationId);
  const excluded = useMemo(
    () => (excludeKeys?.length ? [...excludedKeys, ...excludeKeys] : excludedKeys),
    [excludeKeys],
  );

  const saveMutation = useMutation({
    retry: false,
    mutationKey: ["integration-config", admin.apiUrl, integrationId],
    mutationFn: async (updates: Record<string, unknown>) => {
      await admin.patchConfig(integrationId, updates);
      void admin.refresh();
      if (owner.active) onSaved?.();
    },
  });

  return (
    <SchemaConfigForm
      draftId={JSON.stringify([admin.apiUrl, "integration", integrationId])}
      key={JSON.stringify([admin.apiUrl, integrationId])}
      schema={schema}
      resolvedConfig={resolvedConfig}
      ownership={ownership}
      excludeKeys={excluded}
      onSave={async (diff) => {
        await saveMutation.mutateAsync(diff);
      }}
      emptyMessage={t("noEditableConfigurationFieldsOnly")}
    />
  );
}
