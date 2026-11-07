import {
  type AdminIntegrationConfigEntry,
  adminIntegrationConfigImportSchema,
} from "@openmapx/core/api-contracts";
import { getSecretFields, validateConfigBody } from "../utils/validate-config-body";
import type { TrustedConfigurationApplyOutcome } from "./trusted-config-outcome";

type Schemas = ReadonlyMap<string, Record<string, unknown> | undefined>;
type SavedConfig = { integrationId: string; config: Record<string, unknown> | null };
export class IntegrationImportValidationError extends Error {
  constructor(
    readonly errors: string[] = [
      "Invalid integration import: expected a nonempty batch with unique integration IDs and object configs",
    ],
  ) {
    super("Invalid integration import");
  }
}
function hasMask(value: unknown): boolean {
  return (
    value === "***" ||
    (Array.isArray(value)
      ? value.some(hasMask)
      : value !== null && typeof value === "object" && Object.values(value).some(hasMask))
  );
}
/** One manifest authority for ordinary edits and imports; never echo supplied values. */
export function prepareIntegrationImport(
  body: unknown,
  schemas: Schemas,
): AdminIntegrationConfigEntry[] {
  const parsed = adminIntegrationConfigImportSchema.safeParse(body);
  if (!parsed.success) {
    throw new IntegrationImportValidationError(
      parsed.error.issues.slice(0, 8).map((issue) => {
        const index =
          issue.path[0] === "integrations" && typeof issue.path[1] === "number"
            ? issue.path[1]
            : undefined;
        const entry = index === undefined ? "Import" : `Entry ${index + 1}`;
        const field =
          issue.path[2] === "config" ? (issue.path[3] === "enabled" ? " enabled" : " config") : "";
        return `${entry}${field}: ${issue.code === "custom" && issue.message === "Duplicate integration ID" ? "duplicate integration ID" : "invalid batch, entry or field shape"}`;
      }),
    );
  }
  const errors: string[] = [];
  const entries = parsed.data.integrations.map(({ integrationId, config }, index) => {
    const at = `Entry ${index + 1}`;
    if (!schemas.has(integrationId)) {
      errors.push(`${at}: unknown integration ID`);
      return { integrationId, config };
    }
    // Only catalogue identifiers/field names are eligible for display, never
    // supplied values, unknown keys, or validator messages containing schema data.
    const label = /^[a-z0-9-]{1,64}$/.test(integrationId) ? `${at} (${integrationId})` : at;
    const schema = schemas.get(integrationId);
    const properties = (schema?.properties ?? schema ?? {}) as Record<string, unknown>;
    const secrets = new Set(getSecretFields(schema).map((f) => f.key));
    const { enabled, ...fields } = config;
    const updates: Record<string, unknown> = {};
    for (const [fieldIndex, [key, value]] of Object.entries(fields).entries()) {
      if (secrets.has(key)) continue;
      const known = Object.hasOwn(properties, key) && key !== "type" && key !== "properties";
      const field =
        known && /^[A-Za-z0-9_.-]{1,80}$/.test(key) ? `field "${key}"` : `field #${fieldIndex + 1}`;
      if (!known) {
        errors.push(`${label}: ${field} is not a writable field`);
        continue;
      }
      if (hasMask(value)) {
        errors.push(`${label}: ${field} contains a masked placeholder`);
        continue;
      }
      const checked = validateConfigBody({ [key]: value }, schema);
      if (checked.errors.length) {
        const diagnostic = checked.errors[0];
        const rules: [RegExp, string][] = [
          [/is read-only/, "read-only constraint"],
          [/must be at least|must have at least|must contain at least/, "minimum constraint"],
          [/must be at most|must have at most|must contain at most/, "maximum constraint"],
          [/must be one of:/, "allowed-choice constraint"],
          [/must equal/, "constant constraint"],
          [/is required/, "required-field constraint"],
          [/is not allowed|Unknown config key/, "allowed-field constraint"],
          [/secret field/, "non-secret-field constraint"],
          [/must be (a|an) (boolean|string|number|integer|array|object)$/, "type constraint"],
        ];
        const rule =
          rules.find(([pattern]) => pattern.test(diagnostic))?.[1] ?? "type or value constraints";
        errors.push(`${label}: ${field} violates its ${rule}`);
      } else Object.assign(updates, checked.updates);
    }
    return {
      integrationId,
      config: { ...updates, ...(enabled !== undefined ? { enabled } : {}) },
    } as AdminIntegrationConfigEntry;
  });
  if (errors.length) throw new IntegrationImportValidationError(errors.slice(0, 8));
  return entries;
}
/** Old/unknown DB metadata is deliberately omitted, never guessed to be nonsecret. */
export function exportIntegrationConfigs(rows: SavedConfig[], schemas: Schemas) {
  const integrations: AdminIntegrationConfigEntry[] = [];
  for (const row of rows) {
    if (!schemas.has(row.integrationId)) continue;
    const schema = schemas.get(row.integrationId);
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row.config ?? {})) {
      if (key === "enabled") {
        if (typeof value === "boolean") config.enabled = value;
        continue;
      }
      if (key === "type" || key === "properties" || hasMask(value)) continue;
      const checked = validateConfigBody({ [key]: value }, schema);
      if (!checked.errors.length) Object.assign(config, checked.updates);
    }
    integrations.push({ integrationId: row.integrationId, config } as AdminIntegrationConfigEntry);
  }
  return { integrations, exportedAt: new Date().toISOString(), count: integrations.length };
}

export function completeConfigurationApply(outcome: TrustedConfigurationApplyOutcome): boolean {
  return (
    outcome.outcome === "committed" &&
    outcome.followUp === "complete" &&
    !outcome.cleanupFailed &&
    !outcome.publisherCleanupFailed &&
    !outcome.registryUpdateFailed
  );
}
