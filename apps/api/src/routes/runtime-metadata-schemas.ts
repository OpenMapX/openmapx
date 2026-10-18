import { routeJsonSchema } from "@openmapx/core/api-schema";
import type { z } from "zod/v4";

/** Keep Fastify's runtime serializer and Swagger on the same output schema. */
export function runtimeMetadataJsonSchema(schema: z.ZodType, id: string) {
  return { $id: id, ...routeJsonSchema(schema, { identity: id, io: "output" }) };
}
