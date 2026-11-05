import z from "zod/v4";
export const accountRoleSchema = z.enum(["user", "admin", "privacy_admin"]);
export const accountMailOutcomeSchema = z.enum([
  "not_requested",
  "queued",
  "sent",
  "failed",
  "unknown",
]);
export type AccountMailOutcome = z.infer<typeof accountMailOutcomeSchema>;
export const provisionAccountSchema = z.strictObject({
  name: z.string().trim().min(1).max(256),
  email: z.email().max(320),
  role: accountRoleSchema.default("user"),
  password: z.string().min(8).max(128).optional(),
  sendInvitation: z.boolean(),
});
export const accountReasonSchema = z.enum([
  "identity_verified_out_of_band",
  "account_recovery",
  "operator_request",
]);
export const assistedAccountVerifySchema = z.strictObject({
  confirmed: z.literal(true),
  reasonCode: accountReasonSchema,
  expectedEmail: z.email().max(320),
});
export const assistedAccountPasswordSchema = z.strictObject({
  confirmed: z.literal(true),
  reasonCode: accountReasonSchema,
  password: z.string().min(8).max(128),
});
export const accountMailActionSchema = z.strictObject({ confirmed: z.literal(true) });
export const accountRoleChangeSchema = z.strictObject({
  role: accountRoleSchema,
  expectedRole: accountRoleSchema,
});
export const accountProvisioningResultSchema = z.strictObject({
  userId: z.string(),
  created: z.boolean(),
  verificationDelivery: accountMailOutcomeSchema,
  passwordSetupDelivery: accountMailOutcomeSchema,
});
export type AccountProvisioningResult = z.infer<typeof accountProvisioningResultSchema>;
export const accountDeliverySchema = z.strictObject({
  latest: z
    .strictObject({
      action: z.enum(["create", "invitation", "verification-email", "reset-password"]),
      requestedAt: z.iso.datetime(),
      verificationDelivery: accountMailOutcomeSchema,
      passwordSetupDelivery: accountMailOutcomeSchema,
    })
    .nullable(),
});
export type AccountDelivery = z.infer<typeof accountDeliverySchema>;
