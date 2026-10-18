import z from "zod/v4";

export const countSchema = z.number().finite().nonnegative();
export const timestampSchema = z.iso.datetime({ offset: true });
export const errorResponseSchema = z.strictObject({
  error: z.string(),
  ok: z.literal(false).optional(),
  message: z.string().optional(),
  jobId: z.string().optional(),
});
export const frameworkErrorSchema = z.strictObject({
  statusCode: z.number().int().min(400).max(599),
  error: z.string(),
  message: z.string(),
  code: z.string().optional(),
});
export const httpErrorSchema = z.union([errorResponseSchema, frameworkErrorSchema]);
export const okSchema = z.strictObject({ ok: z.literal(true) });
export const acceptedSchema = z.strictObject({ accepted: z.literal(true) });
export const streamErrorSchema = z.strictObject({ event: z.literal("error"), message: z.string() });
export const messageProgressSchema = z.strictObject({
  event: z.literal("progress"),
  message: z.string(),
});
export const byteProgressSchema = z.strictObject({
  event: z.literal("progress"),
  bytes: countSchema,
  totalBytes: countSchema.optional(),
});
export const regionSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/)
  .refine((v) => !v.includes("..") && !v.startsWith("/") && !v.endsWith("/"), "invalid region");
export const regionBodySchema = z.strictObject({ region: regionSchema });
export const json = <S extends z.ZodType>(schema: S, headers?: z.ZodType) => ({
  kind: "json" as const,
  schema,
  ...(headers ? { headers } : {}),
});
export const ndjson = <S extends z.ZodType>(schema: S, headers?: z.ZodType) => ({
  kind: "ndjson" as const,
  schema,
  ...(headers ? { headers } : {}),
});
export const empty = { kind: "empty" } as const;
/** Common Fastify validation, auth and uncaught-error envelopes; business variants are added per operation. */
export const serviceErrors = {
  400: json(httpErrorSchema),
  401: json(httpErrorSchema),
  500: json(httpErrorSchema),
} as const;
export const publicErrors = { 400: json(httpErrorSchema), 500: json(httpErrorSchema) } as const;
export interface DataManagerOperation {
  method: "GET" | "POST" | "DELETE" | "HEAD";
  path: string;
  auth: "public" | "service" | "capability";
  request?: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType; headers?: z.ZodType };
  /** Endpoint-specific validation errors preserve established principal/error discriminants. */
  requestErrors?: Partial<
    Record<
      "body" | "query" | "params" | "headers",
      Readonly<Record<string, string | number | boolean | null>>
    >
  >;
  responses: Record<
    number,
    { headers?: z.ZodType } & (
      | { kind: "json" | "ndjson"; schema: z.ZodType }
      | { kind: "raw"; contentTypes: readonly string[] }
      | { kind: "empty" }
    )
  >;
}
