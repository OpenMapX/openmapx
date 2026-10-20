"use client";

import type { AdminIntegrationResolvedConfig } from "@openmapx/core/api-contracts";
import { useMutation } from "@tanstack/react-query";
import { useIntegrationAdmin } from "@/lib/admin/integrationAdmin";
import { SchemaConfigForm } from "../shared/SchemaConfigForm";

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

  const saveMutation = useMutation({
    retry: false,
    mutationFn: (updates: Record<string, unknown>) => admin.patchConfig(integrationId, updates),
    onSuccess: () => {
      void admin.refresh();
      onSaved?.();
    },
  });

  return (
    <SchemaConfigForm
      schema={schema}
      resolvedConfig={resolvedConfig}
      excludeKeys={["enabled"]}
      onSave={async (diff) => {
        await saveMutation.mutateAsync(diff);
      }}
      emptyMessage="No editable configuration fields. Only secrets and the enabled toggle are available for this integration."
    />
  );
}
