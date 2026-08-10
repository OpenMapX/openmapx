/**
 * Lightweight per-property validator + introspection helpers for the
 * JSON-Schema-shaped manifest `configSchema` block used by both integrations
 * and services.
 *
 * Supports the JSON Schema subset emitted by integration manifests:
 * - scalar, array, and object types
 * - enum / const / oneOf / allOf / if-then-else
 * - required and additionalProperties
 * - string, numeric, and collection bounds
 * - nested URL validation
 * - `x-openmapx-secret: true` (must be set via credentials API, not config)
 *
 * The validator returns an `{ updates, errors }` pair; callers persist updates
 * only when errors is empty.
 */

import { type CredentialSetup, readCredentialSetup } from "@openmapx/integration-framework";

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
  /** Operator "how to obtain this key" guidance from `x-openmapx-setup`. */
  setup?: CredentialSetup;
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
        setup: readCredentialSetup(def),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string[] {
  if (Array.isArray(schema.allOf)) {
    const { allOf, ...baseSchema } = schema;
    return [
      ...validateSchemaValue(value, baseSchema, path),
      ...allOf.flatMap((entry) =>
        isRecord(entry)
          ? validateSchemaValue(value, entry, path)
          : [`${path} has an invalid schema`],
      ),
    ];
  }

  if (isRecord(schema.if)) {
    const { if: condition, then, else: otherwise, ...baseSchema } = schema;
    const conditionMatches = validateSchemaValue(value, condition, path).length === 0;
    const branch = conditionMatches ? then : otherwise;
    return [
      ...validateSchemaValue(value, baseSchema, path),
      ...(isRecord(branch) ? validateSchemaValue(value, branch, path) : []),
    ];
  }

  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    const candidateResults = oneOf.map((candidate) =>
      isRecord(candidate)
        ? validateSchemaValue(value, candidate, path)
        : [`${path} has an invalid schema`],
    );
    const matches = candidateResults.filter((errors) => errors.length === 0);
    if (matches.length === 1) return [];
    if (matches.length > 1) return [`${path} matches more than one allowed shape`];
    const discriminator =
      isRecord(value) && typeof value.type === "string" ? ` for type "${value.type}"` : "";
    return [`${path} does not match an allowed shape${discriminator}`];
  }

  if ("const" in schema && value !== schema.const) {
    return [`${path} must equal ${JSON.stringify(schema.const)}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [`${path} must be one of: ${schema.enum.join(", ")}`];
  }

  const type = schema.type;
  if (type === "boolean" && typeof value !== "boolean") return [`${path} must be a boolean`];
  if (type === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return [`${path} must have at least ${schema.minLength} characters`];
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return [`${path} must have at most ${schema.maxLength} characters`];
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      return [`${path} has an invalid format`];
    }
    if (schema.format === "url" && value !== "") {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return [`${path} must be a valid http(s) URL`];
        }
      } catch {
        return [`${path} must be a valid http(s) URL`];
      }
    }
    return [];
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be a number`];
    if (type === "integer" && !Number.isInteger(value)) return [`${path} must be an integer`];
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return [`${path} must be at least ${schema.minimum}`];
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return [`${path} must be at most ${schema.maximum}`];
    }
    return [];
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return [`${path} must contain at least ${schema.minItems} item(s)`];
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return [`${path} must contain at most ${schema.maxItems} item(s)`];
    }
    if (!isRecord(schema.items)) return [];
    return value.flatMap((entry, index) =>
      validateSchemaValue(entry, schema.items as Record<string, unknown>, `${path}[${index}]`),
    );
  }
  if (type === "object") {
    if (!isRecord(value)) return [`${path} must be an object`];
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set<unknown>();
    const errors: string[] = [];
    for (const key of required) {
      if (typeof key === "string" && !(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      const nestedSchema = properties[key];
      if (!isRecord(nestedSchema)) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
        continue;
      }
      errors.push(...validateSchemaValue(nestedValue, nestedSchema, `${path}.${key}`));
    }
    return errors;
  }
  return [];
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
    if (def.readOnly === true) {
      result.errors.push(`"${key}" is read-only`);
      continue;
    }
    if (rejectEnabled && key === "enabled") {
      result.errors.push(`"enabled" must be set via the enable/disable endpoints`);
      continue;
    }

    const errors = validateSchemaValue(value, def, `"${key}"`);
    if (errors.length > 0) {
      result.errors.push(...errors);
      continue;
    }

    result.updates[key] = value;
  }

  return result;
}
