import z from "zod/v4";
import { httpErrorSchema } from "../../../services/data-manager/contracts/common";

export { httpErrorSchema };
export const adminTimestampSchema = z.iso.datetime({ offset: true });
export const adminCountSchema = z.number().int().nonnegative().safe();
export const adminRateLimitSchema = z.strictObject({
  error: z.string(),
  retryAfter: adminCountSchema,
});
export const adminJson = <S extends z.ZodType>(schema: S, headers?: z.ZodType) => ({
  kind: "json" as const,
  schema,
  ...(headers ? { headers } : {}),
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
export interface DataManagerAdminOperation {
  method: "GET" | "POST" | "DELETE";
  path: `/api/${string}`;
  auth: "service" | "admin";
  request?: { body?: z.ZodType; query?: z.ZodType; params?: z.ZodType };
  responses: Record<number, { kind: "json"; schema: z.ZodType; headers?: z.ZodType }>;
}
