import z from "zod/v4";
import { adminCountSchema } from "../admin";

export const adminServiceDeploymentSchema = z.strictObject({
  selfHosted: z.boolean(),
  dockerAvailable: z.boolean(),
  hostControlConfigured: z.boolean(),
  hostDir: z.string().nullable(),
  composeRendered: z.boolean(),
  infraDir: z.string(),
});
export const adminServiceHardlinksSchema = z.strictObject({
  applied: z.boolean(),
  linked: adminCountSchema,
  skipped: adminCountSchema,
  pruned: adminCountSchema,
  entries: adminCountSchema,
  via: z.string().optional(),
});
export const adminServiceComposeStartedSchema = z.strictObject({
  ok: z.boolean(),
  stdout: z.string(),
  hardlinks: adminServiceHardlinksSchema,
});
export const ADMIN_COMPOSE_REVISION_HEADER = "x-openmapx-current-configuration";
export const adminComposeRenderInputSchema = z.strictObject({
  expectedCurrentRevisionId: z
    .string()
    .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
    .nullable(),
  confirmed: z.literal(true),
});
export const adminComposePreviewHeadersSchema = z.object({
  [ADMIN_COMPOSE_REVISION_HEADER]: z.union([
    z.literal("none"),
    z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  ]),
});
export const adminDawarichSecretStateSchema = z.enum(["missing", "consistent", "conflict"]);
export const adminDawarichStatusSchema = z.strictObject({
  installed: z.boolean(),
  selected: z.boolean(),
  running: z.boolean(),
  healthy: z.boolean(),
  publicOrigin: z.string().nullable(),
  oauthClient: z.strictObject({
    present: z.boolean(),
    clientId: z.string().nullable(),
    redirectUriMatches: z.boolean(),
    settingsMatch: z.boolean(),
    recoveryRequired: z.boolean(),
  }),
  secrets: z.strictObject({
    databasePassword: adminDawarichSecretStateSchema,
    secretKeyBase: adminDawarichSecretStateSchema,
    oidcClientSecret: adminDawarichSecretStateSchema,
  }),
  configReady: z.boolean(),
  readyToStart: z.boolean(),
  needsApply: z.boolean(),
});
export const adminDawarichProvisionSchema = z
  .strictObject({ publicHost: z.string().optional() })
  .optional();
export const adminDawarichRotateSchema = z.strictObject({
  confirmation: z.literal("ROTATE DAWARICH OIDC SECRET"),
});
export const adminDawarichConflictCodeSchema = z.enum([
  "DAWARICH_OAUTH_CLIENT_CONFLICT",
  "DAWARICH_DATABASE_SECRET_CONFLICT",
  "DAWARICH_RAILS_SECRET_CONFLICT",
]);
export const adminDawarichConflictSchema = z.strictObject({
  code: adminDawarichConflictCodeSchema,
});
export const adminDawarichBundleConflictSchema = z.strictObject({
  code: z.enum([...adminDawarichConflictCodeSchema.options, "DAWARICH_BUNDLE_NOT_INSTALLED"]),
});
export const adminDawarichInvalidHostSchema = z.strictObject({
  code: z.literal("DAWARICH_INVALID_PUBLIC_HOST"),
});
export const adminDawarichUnavailableSchema = z.strictObject({
  code: z.enum(["DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED", "DAWARICH_PROVISIONING_FAILED"]),
});
export const adminDawarichConfirmationErrorSchema = z.strictObject({
  code: z.literal("DAWARICH_ROTATION_CONFIRMATION_REQUIRED"),
});
export const adminServiceSharedMobilityCategorySchema = z.enum(["bike", "scooter", "car"]);
export const adminServiceSharedMobilityDecisionSchema = z.strictObject({
  policy: z.enum(["fanout", "shadow", "motis-first"]),
  local: z.enum(["healthy", "partial", "error"]),
  served: z.enum(["motis-first", "fanout"]),
  calledAdapters: z.array(z.string()),
  skippedAdapters: z.array(z.string()),
  partial: z.boolean(),
  stationDelta: z.number().int().safe().optional(),
  vehicleDelta: z.number().int().safe().optional(),
});
export const adminServiceSharedMobilitySchema = z.strictObject({
  rollbackCategories: z.array(adminServiceSharedMobilityCategorySchema),
  decisions: z.array(
    z.strictObject({
      category: adminServiceSharedMobilityCategorySchema,
      recordedAt: z.string(),
      decision: adminServiceSharedMobilityDecisionSchema,
    }),
  ),
});
export const adminServiceSharedMobilityRollbackSchema = z.strictObject({ enabled: z.boolean() });
export const adminServiceSharedMobilityParamsSchema = z.strictObject({
  category: adminServiceSharedMobilityCategorySchema,
});

export type AdminServiceDeployment = z.infer<typeof adminServiceDeploymentSchema>;
export type AdminServiceHardlinks = z.infer<typeof adminServiceHardlinksSchema>;
export type AdminServiceComposeStarted = z.infer<typeof adminServiceComposeStartedSchema>;
export type AdminDawarichSecretState = z.infer<typeof adminDawarichSecretStateSchema>;
export type AdminDawarichStatus = z.infer<typeof adminDawarichStatusSchema>;
export type AdminDawarichProvision = z.infer<typeof adminDawarichProvisionSchema>;
export type AdminDawarichRotate = z.infer<typeof adminDawarichRotateSchema>;
export type AdminDawarichConflictCode = z.infer<typeof adminDawarichConflictCodeSchema>;
export type AdminServiceSharedMobilityCategory = z.infer<
  typeof adminServiceSharedMobilityCategorySchema
>;
export type AdminServiceSharedMobilityDecision = z.infer<
  typeof adminServiceSharedMobilityDecisionSchema
>;
export type AdminServiceSharedMobility = z.infer<typeof adminServiceSharedMobilitySchema>;
export type AdminServiceSharedMobilityRollback = z.infer<
  typeof adminServiceSharedMobilityRollbackSchema
>;
