import { z } from "zod/v4";

export interface RouteJsonSchemaOptions {
  identity: string;
  io: "input" | "output";
  registerDefinition?: (schema: Record<string, unknown> & { $id: string }) => void;
}

function omitUnrestrictedPropertyNames(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  const names = node.propertyNames;
  if (
    names &&
    typeof names === "object" &&
    Object.keys(names).length === 1 &&
    (names as { type?: unknown }).type === "string"
  )
    delete node.propertyNames;
  for (const child of Object.values(node)) omitUnrestrictedPropertyNames(child);
}

/** Emit runtime draft-7 schemas without coupling contracts to a server framework. */
export function routeJsonSchema(
  schema: z.ZodType,
  options: RouteJsonSchemaOptions,
): Record<string, unknown> {
  const {
    $schema: _dialect,
    definitions,
    $defs,
    ...source
  } = z.toJSONSchema(schema, { target: "draft-7", io: options.io });
  if (!options.registerDefinition) {
    const result = {
      ...source,
      ...(definitions ? { definitions } : {}),
      ...($defs ? { $defs } : {}),
    };
    omitUnrestrictedPropertyNames(result);
    return result;
  }
  const localDefinitions = {
    ...(definitions && typeof definitions === "object" ? definitions : {}),
    ...$defs,
  };
  const identities = new Map(
    Object.keys(localDefinitions).map((name) => [name, `${options.identity}_${name}`]),
  );
  function rewrite(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === "$ref" && typeof child === "string") {
          const match = /^#\/(?:definitions|\$defs)\/(.+)$/.exec(child);
          if (match) {
            const name = (match[1] ?? "").replaceAll("~1", "/").replaceAll("~0", "~");
            const id = identities.get(name);
            if (!id) throw new Error(`Unresolved route schema reference: ${options.identity}`);
            return [key, `${id}#`];
          }
        }
        return [key, rewrite(child)];
      }),
    );
  }
  const result = rewrite(source) as Record<string, unknown>;
  omitUnrestrictedPropertyNames(result);
  for (const [name, definition] of Object.entries(localDefinitions)) {
    const resolved = rewrite(definition) as Record<string, unknown>;
    omitUnrestrictedPropertyNames(resolved);
    const id = identities.get(name);
    if (!id) throw new Error("Missing route schema identity");
    options.registerDefinition?.({ ...resolved, $id: id });
  }
  return result;
}

/** Fastify uses draft-7 tuples; OpenAPI 3.1 uses the 2020-12 spelling. */
export function convertJsonSchemaTuplesToOpenApi31(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  if (Array.isArray(schema.items)) {
    schema.prefixItems = schema.items;
    schema.items = schema.additionalItems ?? true;
    delete schema.additionalItems;
  }
  for (const child of Object.values(schema)) convertJsonSchemaTuplesToOpenApi31(child);
}
