"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEnv } from "@/lib/EnvProvider";
import { invalidateIntegrationRuntime } from "@/lib/integrationRuntimeQuery";
import { type ConfigFieldSource, SchemaConfigForm } from "../shared/SchemaConfigForm";

interface ConfigSchemaFormProps {
  integrationId: string;
  /** The manifest configSchema object. */
  schema: Record<string, unknown> | undefined;
  /** Resolved config values with source annotations. */
  resolvedConfig: Record<string, { value: unknown; source: ConfigFieldSource }>;
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
  const { apiUrl } = useEnv();
  const qc = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: async (updates: Record<string, unknown>) => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/${integrationId}/config`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          (err as { errors?: string[] })?.errors?.join(", ") ??
            (err as { error?: string })?.error ??
            "Save failed",
        );
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "integrations", integrationId] });
      void invalidateIntegrationRuntime(qc, apiUrl);
      onSaved?.();
    },
  });

  return (
    <SchemaConfigForm
      schema={schema}
      resolvedConfig={resolvedConfig}
      excludeKeys={["enabled"]}
      onSave={(diff) => saveMutation.mutateAsync(diff)}
      emptyMessage="No editable configuration fields. Only secrets and the enabled toggle are available for this integration."
    />
  );
}
