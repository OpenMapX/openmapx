import z from "zod/v4";
export const accountRoleSchema = z.enum(["user", "admin"]);
export const accountMailOutcomeSchema = z.enum([
  "not_requested",
  "queued",
  "sent",
  "failed",
  "unknown",
]);
export type AccountMailOutcome = z.infer<typeof accountMailOutcomeSchema>;
/** The kinds of account mail: the mail outbox and the account action receipts use these names. */
export const ACCOUNT_MAIL_KINDS = [
  "email_verification",
  "password_reset",
  "password_setup",
] as const;
export type AccountMailKind = (typeof ACCOUNT_MAIL_KINDS)[number];
/** The account mail an administrator sends on its own, named by its mail kind. */
const SENT_ACCOUNT_MAIL_KINDS = [
  "email_verification",
  "password_reset",
] as const satisfies readonly AccountMailKind[];
/** The actions an account action receipt records whose latest delivery is reported. */
export const ACCOUNT_DELIVERY_ACTIONS = [
  "create",
  "invitation",
  ...SENT_ACCOUNT_MAIL_KINDS,
] as const;
/** Every action an account action receipt records. */
export const ACCOUNT_ACTIONS = [...ACCOUNT_DELIVERY_ACTIONS, "verify", "password", "role"] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];
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
      action: z.enum(ACCOUNT_DELIVERY_ACTIONS),
      requestedAt: z.iso.datetime(),
      verificationDelivery: accountMailOutcomeSchema,
      passwordSetupDelivery: accountMailOutcomeSchema,
    })
    .nullable(),
});
export type AccountDelivery = z.infer<typeof accountDeliverySchema>;
