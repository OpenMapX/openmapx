import z from "zod/v4";
/** Editable ownership metadata only. Never host paths, values or secret hashes. */
export const configurationOwnershipSchema = z.strictObject({
  source: z.enum(["default", "database", "vault", "config.json", "env"]),
  writable: z.boolean(),
  secret: z.boolean(),
  adoption: z.enum(["direct", "host_action_required"]),
  reason: z.enum(["host_environment", "host_file", "vault_only", "managed_workflow"]).nullable(),
  envVar: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
    .optional(),
  managedBy: z.enum(["transit.credentials", "dawarich-provisioning"]).optional(),
});
export type ConfigurationOwnership = z.infer<typeof configurationOwnershipSchema>;
export const configurationSourceOwnedSchema = z.strictObject({
  code: z.literal("CONFIGURATION_SOURCE_OWNED"),
  error: z.string(),
  ownership: configurationOwnershipSchema,
});

export const configurationVersionConflictSchema = z.strictObject({
  code: z.literal("CONFIGURATION_VERSION_CONFLICT"),
  error: z.string(),
});
