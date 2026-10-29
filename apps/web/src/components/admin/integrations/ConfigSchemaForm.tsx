"use client";

import type { AdminIntegrationResolvedConfig } from "@openmapx/core/api-contracts";
import { useMutation } from "@tanstack/react-query";
import { useIntegrationAdmin } from "@/lib/admin/integrationAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { SchemaConfigForm } from "../shared/SchemaConfigForm";

const excludedKeys = ["enabled"];

interface ConfigSchemaFormProps {
  integrationId: string;
  /** The manifest configSchema object. */
  schema: Record<string, unknown> | undefined;
  /** Resolved config values with source annotations. */
  resolvedConfig: AdminIntegrationResolvedConfig;
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
  schema,
  resolvedConfig,
  onSaved,
}: ConfigSchemaFormProps) {
  const admin = useIntegrationAdmin();
  const owner = useAdminMutationOwner(admin.client, integrationId);

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
      key={JSON.stringify([admin.apiUrl, integrationId])}
      schema={schema}
      resolvedConfig={resolvedConfig}
      excludeKeys={excludedKeys}
      onSave={async (diff) => {
        await saveMutation.mutateAsync(diff);
      }}
      emptyMessage="No editable configuration fields. Only secrets and the enabled toggle are available for this integration."
    />
  );
}
