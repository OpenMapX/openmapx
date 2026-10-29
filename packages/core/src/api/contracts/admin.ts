import z from "zod/v4";
import { httpErrorSchema } from "../../services/data-manager/contracts/common";

export { httpErrorSchema };
export const adminTimestampSchema = z.iso.datetime({ offset: true });
export const adminCountSchema = z.number().int().nonnegative().safe();
/** JSON on the wire deliberately excludes undefined, Dates and executable values. */
export const adminJsonValueSchema = z
  .preprocess((value, context) => {
    // Zod's record parser drops this own key. Reject it before parsing so a
    // successful administration response never silently loses JSON content.
    const pending: unknown[] = [value];
    const seen = new WeakSet<object>();
    while (pending.length) {
      const current = pending.pop();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      if (Object.hasOwn(current, "__proto__")) {
        context.addIssue({ code: "custom", message: "Invalid administration JSON value" });
        return z.NEVER;
      }
      for (const child of Object.values(current)) pending.push(child);
    }
    return value;
  }, z.json())
  .describe("Recursive JSON. Objects with an own __proto__ key are rejected at every depth.");
export type AdminJsonValue = z.infer<typeof adminJsonValueSchema>;
export const adminRateLimitSchema = z.strictObject({
  error: z.string(),
  retryAfter: adminCountSchema,
});
export const adminJson = <S extends z.ZodType>(schema: S, headers?: z.ZodType) => ({
  kind: "json" as const,
  schema,
  ...(headers ? { headers } : {}),
});
export const adminText = <S extends z.ZodType<string>>(
  schema: S,
  mediaType = "text/plain",
  headers?: z.ZodType,
) => ({ kind: "text" as const, schema, mediaType, ...(headers ? { headers } : {}) });
export const adminEmpty = (headers?: z.ZodType) => ({
  kind: "empty" as const,
  ...(headers ? { headers } : {}),
});
export const adminStream = (mediaType: string, headers?: z.ZodType) => ({
  kind: "stream" as const,
  mediaType,
  ...(headers ? { headers } : {}),
});
export const adminBytes = (mediaType: string, headers?: z.ZodType, nativeDownload?: true) => ({
  kind: "bytes" as const,
  mediaType,
  ...(headers ? { headers } : {}),
  ...(nativeDownload ? { nativeDownload } : {}),
});
export const adminCommonResponses = {
  400: adminJson(httpErrorSchema),
  401: adminJson(httpErrorSchema),
  403: adminJson(httpErrorSchema),
  413: adminJson(httpErrorSchema),
  415: adminJson(httpErrorSchema),
  429: adminJson(adminRateLimitSchema, z.object({ "retry-after": z.string().regex(/^\d+$/) })),
  500: adminJson(httpErrorSchema),
} as const;
export type AdminResponseContract =
  | { kind: "json"; schema: z.ZodType; headers?: z.ZodType }
  | { kind: "text"; schema: z.ZodType<string>; mediaType: string; headers?: z.ZodType }
  | { kind: "empty"; headers?: z.ZodType }
  | { kind: "bytes"; mediaType: string; headers?: z.ZodType; nativeDownload?: true }
  | { kind: "stream"; mediaType: string; headers?: z.ZodType };
export interface AdminOperation {
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  path: `/api/${string}`;
  auth: "service" | "admin";
  request?: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType; headers?: z.ZodType };
  requestBody?: { kind: "bytes"; mediaType: "application/octet-stream" };
  responses: Record<number, AdminResponseContract>;
}

/** Reject malformed first-party descriptors before registration or SDK acquisition. */
export function assertAdminOperationContract(operation: AdminOperation): void {
  if (
    operation.requestBody &&
    (operation.request?.body ||
      operation.requestBody.kind !== "bytes" ||
      operation.requestBody.mediaType !== "application/octet-stream")
  )
    throw Error("Ambiguous administration binary request");
  for (const [status, contract] of Object.entries(operation.responses)) {
    if (
      "nativeDownload" in contract &&
      (contract.nativeDownload !== true ||
        contract.kind !== "bytes" ||
        operation.method !== "GET" ||
        Number(status) < 200 ||
        Number(status) >= 300)
    )
      throw Error("Native downloads require a successful GET byte response");
  }
}
