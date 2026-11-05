import z from "zod/v4";
import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";
import { adminServiceIdempotencyHeadersSchema } from "../service-admin/common";
export const adminReauthPurposeSchema = z.enum([
  "account.verify",
  "account.password.set",
  "account.reset.send",
  "account.invite",
  "credentials.export",
  "credentials.import",
  "transit.credentials",
  "platform.domain.apply",
]);
export type AdminReauthPurpose = z.infer<typeof adminReauthPurposeSchema>;
const intentFields = {
  purpose: adminReauthPurposeSchema,
  targetId: z.string().min(1).max(256),
  intentFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};
const validateIntent = (
  v: { purpose: AdminReauthPurpose; targetId: string; intentFingerprint?: string },
  ctx: z.RefinementCtx,
) => {
  if (
    v.purpose === "platform.domain.apply" &&
    (!/^[a-f0-9]{64}$/.test(v.targetId) ||
      (v.intentFingerprint !== undefined && v.intentFingerprint !== v.targetId))
  )
    ctx.addIssue({ code: "custom", message: "Invalid domain preview reference" });
  if (["transit.credentials", "credentials.import"].includes(v.purpose) && !v.intentFingerprint)
    ctx.addIssue({ code: "custom", message: "A checked mutation intent is required" });
};
export const adminReauthIntentSchema = z.strictObject(intentFields).superRefine(validateIntent);
export const adminReauthStartSchema = z
  .strictObject({ ...intentFields, restart: z.boolean().optional() })
  .superRefine(validateIntent);
export const adminReauthIntentListSchema = z.array(adminReauthIntentSchema).min(1).max(2);
export const adminReauthStoredSchema = z.strictObject({
  phase: z.enum(["login", "completed"]),
  requests: adminReauthIntentListSchema,
  challengeIds: z.array(z.uuid()).min(1).max(2),
  expiresAt: z.iso.datetime(),
  returnPath: z.string(),
});
export type AdminReauthIntent = z.infer<typeof adminReauthIntentSchema>;
export type StoredAdminReauth = z.infer<typeof adminReauthStoredSchema>;
export const adminReauthCompleteSchema = z.strictObject({ challengeId: z.uuid() });
export const adminReauthStartedSchema = z.strictObject({
  challengeId: z.uuid(),
  expiresAt: z.iso.datetime(),
  loginPath: z.literal("/auth/admin"),
});
export type AdminReauthProofRef = { challengeId: string };

export const adminReauthOperations = {
  startAdminReauthentication: {
    method: "POST",
    path: "/api/admin/reauth/start",
    auth: "admin",
    request: { body: adminReauthStartSchema, headers: adminServiceIdempotencyHeadersSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(adminReauthStartedSchema),
      409: adminJson(httpErrorSchema),
      503: adminJson(httpErrorSchema),
    },
  },
  completeAdminReauthentication: {
    method: "POST",
    path: "/api/admin/reauth/complete",
    auth: "admin",
    request: { body: adminReauthCompleteSchema, headers: adminServiceIdempotencyHeadersSchema },
    responses: {
      ...adminCommonResponses,
      200: adminJson(z.strictObject({ completed: z.literal(true) })),
      409: adminJson(httpErrorSchema),
      503: adminJson(httpErrorSchema),
    },
  },
} as const satisfies Record<string, AdminOperation>;
