import z from "zod/v4";
import { type AdminOperation, adminCommonResponses, adminJson } from "../admin";
import { adminServiceAcceptedSchema, adminServiceIdempotencyHeadersSchema } from "./common";
export const adminReleaseClearInputSchema = z.strictObject({
  expectedReleaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  confirmation: z.literal("CLEAR RELEASE PIN"),
});
export const adminImageStageInputSchema = z.strictObject({
  serviceIds: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
    .min(1)
    .max(64)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const releaseControlAdminOperations = {
  pullAdminServiceImages: {
    method: "POST",
    path: "/api/admin/services/images/pull",
    auth: "admin",
    request: { headers: adminServiceIdempotencyHeadersSchema, body: adminImageStageInputSchema },
    responses: {
      202: adminJson(adminServiceAcceptedSchema),
      409: adminJson(z.strictObject({ error: z.string() })),
      503: adminJson(z.strictObject({ error: z.string() })),
      ...adminCommonResponses,
    },
  },
  clearAdminReleaseSelection: {
    method: "POST",
    path: "/api/admin/system/release/clear",
    auth: "admin",
    request: { headers: adminServiceIdempotencyHeadersSchema, body: adminReleaseClearInputSchema },
    responses: {
      202: adminJson(adminServiceAcceptedSchema),
      409: adminJson(z.strictObject({ error: z.string() })),
      503: adminJson(z.strictObject({ error: z.string() })),
      ...adminCommonResponses,
    },
  },
} as const satisfies Record<string, AdminOperation>;
