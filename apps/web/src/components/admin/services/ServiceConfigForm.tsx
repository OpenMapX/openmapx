"use client";

import type { ResolvedConfigValue } from "@/hooks/useServices";
import { SchemaConfigForm } from "../shared/SchemaConfigForm";

interface ServiceConfigFormProps {
  serviceId: string;
  schema: Record<string, unknown> | undefined;
  /** Resolved per-field values with source annotation (default / database / env). */
  resolvedConfig: Record<string, ResolvedConfigValue>;
  /** Env-var prefix (`SERVICE_<ID>_`) shown as an override hint in the header. */
  envPrefix?: string;
  /** Save the new config to the database (no container restart). */
  onSave: (values: Record<string, unknown>) => Promise<void>;
  /**
   * Save and apply the service so the change takes effect — service configs
   * land in the rendered compose environment at container creation time.
   */
  onSaveAndApply?: (values: Record<string, unknown>) => Promise<void>;
}

/**
 * Service config tab — a thin wrapper over the shared {@link SchemaConfigForm}.
 * Service-specific bits: the env-prefix override hint, and the second
 * "Save & apply" action. Secrets are never shown — they live on the Credentials tab.
 */
export function ServiceConfigForm({
  serviceId: _serviceId,
  schema,
  resolvedConfig,
  envPrefix,
  onSave,
  onSaveAndApply,
}: ServiceConfigFormProps) {
  return (
    <SchemaConfigForm
      schema={schema}
      resolvedConfig={resolvedConfig}
      envPrefix={envPrefix}
      onSave={onSave}
      onSaveAndApply={onSaveAndApply}
      applyLabel="Save & apply"
      emptyMessage="No editable configuration fields declared for this service."
    />
  );
}
