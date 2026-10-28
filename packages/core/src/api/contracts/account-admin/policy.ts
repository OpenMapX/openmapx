import z from "zod/v4";
export const authPolicySettingsSchema = z.strictObject({
  emailVerificationRequired: z.boolean(),
  sessionDurationHours: z.number().int().min(1).max(8760),
  twoFaEnabled: z.boolean(),
  passwordMinLength: z.number().int().min(8).max(128),
});
export const authPolicySnapshotSchema = authPolicySettingsSchema.extend({
  activationVersion: z.union([z.literal(0), z.literal(1)]),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const authPolicyApplySchema = z.strictObject({
  settings: authPolicySettingsSchema,
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
});
export const authPolicyViewSchema = z.strictObject({
  active: authPolicySnapshotSchema,
  pending: z.record(z.string(), z.unknown()),
  ownership: z.strictObject({
    emailVerificationRequired: z.enum(["default", "database", "env"]),
    sessionDurationHours: z.enum(["default", "database"]),
    twoFaEnabled: z.enum(["default", "database"]),
    passwordMinLength: z.enum(["default", "database"]),
  }),
});
export type AuthPolicySettings = z.infer<typeof authPolicySettingsSchema>;
export type AuthPolicySnapshot = Readonly<z.infer<typeof authPolicySnapshotSchema>>;
