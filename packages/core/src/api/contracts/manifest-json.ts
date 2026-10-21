import z from "zod/v4";
import { adminJsonValueSchema } from "./admin";

export function adminJsonWire<S extends z.ZodType>(schema: S) {
  return z.preprocess((value, context) => {
    const parsed = adminJsonValueSchema.safeParse(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "Invalid administration JSON value" });
      return z.NEVER;
    }
    return parsed.data;
  }, schema);
}
/** Add JSON catchalls without discarding known validators or collection bounds.
 * Walk only our trusted portable schema, never provider configSchema data.
 */
export function preserveManifestJson<S extends z.core.$ZodType>(schema: S): S {
  let result: z.core.$ZodType = schema;
  if (schema instanceof z.ZodObject) {
    result = schema
      .safeExtend(
        Object.fromEntries(
          Object.entries(schema.shape).map(([key, child]) => [
            key,
            preserveManifestJson(child as z.core.$ZodType),
          ]),
        ),
      )
      .catchall(adminJsonValueSchema);
  } else if (schema instanceof z.ZodArray) {
    result = schema.clone({ ...schema.def, element: preserveManifestJson(schema.element) });
  } else if (schema instanceof z.ZodOptional) {
    result = schema.clone({ ...schema.def, innerType: preserveManifestJson(schema.unwrap()) });
  } else if (schema instanceof z.ZodNullable) {
    result = schema.clone({ ...schema.def, innerType: preserveManifestJson(schema.unwrap()) });
  } else if (schema instanceof z.ZodReadonly) {
    result = schema.clone({ ...schema.def, innerType: preserveManifestJson(schema.unwrap()) });
  } else if (schema instanceof z.ZodUnion) {
    result = schema.clone({
      ...schema.def,
      options: schema.options.map((option) => preserveManifestJson(option)),
    });
  }
  // Only add JSON catchalls; retain the trusted schema's known output types.
  return result as S;
}
