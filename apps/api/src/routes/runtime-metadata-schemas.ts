import { z } from "zod/v4";

/** Keep Fastify's runtime serializer and Swagger on the same output schema. */
export function runtimeMetadataJsonSchema(schema: z.ZodType, id: string) {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "output",
  });
  // JSON object keys are already strings. Zod emits this redundant constraint
  // for records; fast-json-stringify otherwise treats propertyNames as a value
  // schema and emits strict-type warnings while compiling recursive catalogs.
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
  omitUnrestrictedPropertyNames(jsonSchema);
  return { $id: id, ...jsonSchema };
}
