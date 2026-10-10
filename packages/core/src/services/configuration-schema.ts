const FAILED = "Trusted configuration schema rejected";
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 4_096;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_SCHEMA_BRANCHES = 64;
const MAX_PATTERN_LENGTH = 128;
const CONFIG_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
const SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "const",
  "enum",
  "oneOf",
  "allOf",
  "if",
  "then",
  "else",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "items",
  "default",
  "title",
  "description",
  "readOnly",
  "x-openmapx-secret",
  "x-openmapx-setup",
  "x-openmapx-sharedSecretName",
]);

interface Budget {
  nodes: number;
}

function rejected(): never {
  throw new Error(FAILED);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeKey(key: string): boolean {
  return CONFIG_KEY.test(key) && !key.includes("..") && !FORBIDDEN_KEYS.has(key);
}

function boundedJson(value: unknown, depth = 0, budget: Budget = { nodes: 0 }): boolean {
  budget.nodes += 1;
  if (budget.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value !== "string" || value.length <= 8 * 1024;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_SCHEMA_PROPERTIES &&
      value.every((entry) => boundedJson(entry, depth + 1, budget))
    );
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_SCHEMA_PROPERTIES) return false;
  return Object.entries(value).every(
    ([key, child]) => safeKey(key) && boundedJson(child, depth + 1, budget),
  );
}

function safePattern(pattern: string): RegExp {
  if (pattern.length < 1 || pattern.length > MAX_PATTERN_LENGTH || /[(){}|\\]/.test(pattern)) {
    rejected();
  }
  try {
    return new RegExp(pattern, "u");
  } catch {
    rejected();
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertSchemaNode(
  schema: unknown,
  depth: number,
  budget: Budget,
): asserts schema is Record<string, unknown> {
  budget.nodes += 1;
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH || budget.nodes > MAX_SCHEMA_NODES) rejected();
  if (Object.keys(schema).some((key) => !SCHEMA_KEYWORDS.has(key))) rejected();
  if (schema.type !== undefined && (typeof schema.type !== "string" || !TYPES.has(schema.type)))
    rejected();
  if (schema.readOnly !== undefined && typeof schema.readOnly !== "boolean") rejected();
  if (schema["x-openmapx-secret"] !== undefined && typeof schema["x-openmapx-secret"] !== "boolean")
    rejected();
  if (
    schema.title !== undefined &&
    (typeof schema.title !== "string" || schema.title.length > 1_024)
  )
    rejected();
  if (
    schema.description !== undefined &&
    (typeof schema.description !== "string" || schema.description.length > 8 * 1024)
  )
    rejected();
  if (
    schema["x-openmapx-sharedSecretName"] !== undefined &&
    (typeof schema["x-openmapx-sharedSecretName"] !== "string" ||
      (schema["x-openmapx-sharedSecretName"] as string).length > 128)
  )
    rejected();
  if (schema["x-openmapx-setup"] !== undefined && !boundedJson(schema["x-openmapx-setup"]))
    rejected();
  if (schema.default !== undefined && !boundedJson(schema.default)) rejected();
  if (schema.const !== undefined && !boundedJson(schema.const)) rejected();
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length < 1 ||
      schema.enum.length > MAX_SCHEMA_BRANCHES
    )
      rejected();
    if (!schema.enum.every((entry) => boundedJson(entry))) rejected();
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (schema[key] !== undefined && !nonNegativeInteger(schema[key])) rejected();
  }
  if (
    (finiteNumber(schema.minLength) &&
      finiteNumber(schema.maxLength) &&
      schema.minLength > schema.maxLength) ||
    (finiteNumber(schema.minItems) &&
      finiteNumber(schema.maxItems) &&
      schema.minItems > schema.maxItems)
  )
    rejected();
  for (const key of ["minimum", "maximum"] as const) {
    if (schema[key] !== undefined && !finiteNumber(schema[key])) rejected();
  }
  if (
    finiteNumber(schema.minimum) &&
    finiteNumber(schema.maximum) &&
    schema.minimum > schema.maximum
  )
    rejected();
  if (schema.pattern !== undefined && typeof schema.pattern !== "string") rejected();
  if (typeof schema.pattern === "string") safePattern(schema.pattern);
  if (schema.format !== undefined && !["url", "password"].includes(schema.format as string))
    rejected();
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean" &&
    !isRecord(schema.additionalProperties)
  )
    rejected();
  if (isRecord(schema.additionalProperties)) {
    assertSchemaNode(schema.additionalProperties, depth + 1, budget);
  }

  if (schema.properties !== undefined) {
    if (
      !isRecord(schema.properties) ||
      Object.keys(schema.properties).length > MAX_SCHEMA_PROPERTIES
    )
      rejected();
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!safeKey(key)) rejected();
      assertSchemaNode(child, depth + 1, budget);
    }
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.length > MAX_SCHEMA_PROPERTIES ||
      schema.required.some((key) => typeof key !== "string" || !safeKey(key)) ||
      new Set(schema.required).size !== schema.required.length
    )
      rejected();
  }
  if (schema.items !== undefined) assertSchemaNode(schema.items, depth + 1, budget);
  for (const key of ["oneOf", "allOf"] as const) {
    if (schema[key] === undefined) continue;
    const branches = schema[key];
    if (!Array.isArray(branches) || branches.length < 1 || branches.length > MAX_SCHEMA_BRANCHES)
      rejected();
    for (const branch of branches) assertSchemaNode(branch, depth + 1, budget);
  }
  if (schema.if !== undefined) assertSchemaNode(schema.if, depth + 1, budget);
  if (schema.then !== undefined) {
    if (schema.if === undefined) rejected();
    assertSchemaNode(schema.then, depth + 1, budget);
  }
  if (schema.else !== undefined) {
    if (schema.if === undefined) rejected();
    assertSchemaNode(schema.else, depth + 1, budget);
  }
}

function rootSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {}, additionalProperties: false };
  if (
    "properties" in schema ||
    "type" in schema ||
    Object.keys(schema).some((key) => SCHEMA_KEYWORDS.has(key))
  ) {
    return schema;
  }
  return { type: "object", properties: schema, additionalProperties: false };
}

export function assertTrustedConfigurationSchema(
  schema: Record<string, unknown> | undefined,
): void {
  try {
    assertSchemaNode(rootSchema(schema), 0, { nodes: 0 });
  } catch {
    rejected();
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && equalJson(left[key], right[key]))
    );
  }
  return false;
}

function matchesSchema(
  value: unknown,
  schema: Record<string, unknown>,
  depth = 0,
  budget: Budget = { nodes: 0 },
): boolean {
  budget.nodes += 1;
  if (depth > MAX_SCHEMA_DEPTH || budget.nodes > MAX_SCHEMA_NODES) return false;
  if (schema.readOnly === true || schema["x-openmapx-secret"] === true) return false;
  if ("const" in schema && !equalJson(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => equalJson(value, entry)))
    return false;

  const type = schema.type;
  if (type === "boolean" && typeof value !== "boolean") return false;
  if (type === "string") {
    if (typeof value !== "string") return false;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !safePattern(schema.pattern).test(value))
      return false;
    if (schema.format === "url" && value !== "") {
      try {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol)) return false;
      } catch {
        return false;
      }
    }
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (type === "integer" && !Number.isInteger(value)) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  } else if (type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (
      isRecord(schema.items) &&
      !value.every((entry) =>
        matchesSchema(entry, schema.items as Record<string, unknown>, depth + 1, budget),
      )
    )
      return false;
  } else if (type === "object") {
    if (!isRecord(value)) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => typeof key !== "string" || !(key in value))) return false;
    for (const [key, child] of Object.entries(value)) {
      const definition = properties[key];
      if (!isRecord(definition)) {
        if (schema.additionalProperties === false) return false;
        if (
          isRecord(schema.additionalProperties) &&
          !matchesSchema(child, schema.additionalProperties, depth + 1, budget)
        )
          return false;
      } else if (!matchesSchema(child, definition, depth + 1, budget)) return false;
    }
  }

  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every(
      (branch) => isRecord(branch) && matchesSchema(value, branch, depth + 1, budget),
    )
  )
    return false;
  if (Array.isArray(schema.oneOf)) {
    let matches = 0;
    for (const branch of schema.oneOf) {
      if (isRecord(branch) && matchesSchema(value, branch, depth + 1, { nodes: budget.nodes }))
        matches += 1;
    }
    if (matches !== 1) return false;
  }
  if (isRecord(schema.if)) {
    const condition = matchesSchema(value, schema.if, depth + 1, { nodes: budget.nodes });
    const branch = condition ? schema.then : schema.else;
    if (isRecord(branch) && !matchesSchema(value, branch, depth + 1, budget)) return false;
  }
  return true;
}

export function validateTrustedConfigurationValues(
  values: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  controlledKeys: Iterable<string> = [],
): boolean {
  try {
    const root = rootSchema(schema);
    assertTrustedConfigurationSchema(root);
    const properties = isRecord(root.properties) ? { ...root.properties } : {};
    for (const key of controlledKeys) {
      if (!safeKey(key)) rejected();
      properties[key] ??= { type: "boolean" };
    }
    return matchesSchema(values, {
      ...root,
      type: "object",
      properties,
      additionalProperties: false,
    });
  } catch {
    return false;
  }
}
