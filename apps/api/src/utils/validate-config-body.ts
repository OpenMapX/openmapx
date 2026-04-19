/**
 * Lightweight per-property validator + introspection helpers for the
 * JSON-Schema-shaped manifest `configSchema` block used by both integrations
 * and services.
 *
 * Supports the field shapes the admin config form actually emits:
 * - `type: "boolean" | "number" | "integer" | "string"`
 * - `enum: unknown[]`
 * - `x-openmapx-secret: true` (must be set via credentials API, not config)
 *
 * Anything more complex (oneOf, refs, nested objects, arrays) falls through
 * unchanged — those shapes don't render in the form yet anyway. The validator
 * returns an `{ updates, errors }` pair; callers persist `updates` only when
 * `errors` is empty.
 */

/** Walk into the `properties` block of a configSchema (the manifest may nest it under `properties` or omit the wrapping object). */
function configSchemaProperties(
  configSchema: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> {
  if (!configSchema) return {};
  return (configSchema.properties ?? configSchema) as Record<string, Record<string, unknown>>;
}

export interface SecretFieldDescriptor {
  key: string;
  title: string;
  description?: string;
  sharedSecretName?: string;
}

/**
 * Extract fields marked `x-openmapx-secret: true` from a configSchema. These
 * must be persisted through the credentials vault rather than the regular
 * config table — `validateConfigBody` rejects them when `rejectSecrets` is
 * true.
 */
export function getSecretFields(
  configSchema: Record<string, unknown> | undefined,
): SecretFieldDescriptor[] {
  const result: SecretFieldDescriptor[] = [];
  for (const [key, def] of Object.entries(configSchemaProperties(configSchema))) {
    if (key === "type" || key === "properties" || !def || typeof def !== "object") continue;
    if (def["x-openmapx-secret"] === true) {
      result.push({
        key,
        title: (def.title as string) ?? key,
        description: def.description as string | undefined,
        sharedSecretName: def["x-openmapx-sharedSecretName"] as string | undefined,
      });
    }
  }
  return result;
}

export interface ValidatedConfigUpdate {
  updates: Record<string, unknown>;
  errors: string[];
}

export interface ValidateConfigOptions {
  /** When true, "enabled" is rejected with a clear message ("use enable/disable endpoints"). Defaults to true. */
  rejectEnabled?: boolean;
  /** When true, secret fields are rejected ("use credentials API"). Defaults to true. */
  rejectSecrets?: boolean;
}

export function validateConfigBody(
  body: unknown,
  configSchema: Record<string, unknown> | undefined,
  opts: ValidateConfigOptions = {},
): ValidatedConfigUpdate {
  const { rejectEnabled = true, rejectSecrets = true } = opts;
  const result: ValidatedConfigUpdate = { updates: {}, errors: [] };

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    result.errors.push("Body must be a JSON object");
    return result;
  }

  const props = configSchema
    ? ((configSchema.properties ?? configSchema) as Record<string, Record<string, unknown>>)
    : {};

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === "type" || key === "properties") continue;
    const def = props[key];

    if (!def) {
      result.errors.push(`Unknown config key: "${key}"`);
      continue;
    }
    if (rejectSecrets && def["x-openmapx-secret"]) {
      result.errors.push(`"${key}" is a secret field — use the credentials API instead`);
      continue;
    }
    if (rejectEnabled && key === "enabled") {
      result.errors.push(`"enabled" must be set via the enable/disable endpoints`);
      continue;
    }

    const type = def.type as string | undefined;
    if (type === "boolean" && typeof value !== "boolean") {
      result.errors.push(`"${key}" must be a boolean`);
      continue;
    }
    if ((type === "number" || type === "integer") && typeof value !== "number") {
      result.errors.push(`"${key}" must be a number`);
      continue;
    }
    if (type === "string" && typeof value !== "string") {
      result.errors.push(`"${key}" must be a string`);
      continue;
    }
    if (def.enum && !(def.enum as unknown[]).includes(value)) {
      result.errors.push(`"${key}" must be one of: ${(def.enum as unknown[]).join(", ")}`);
      continue;
    }

    result.updates[key] = value;
  }

  return result;
}
