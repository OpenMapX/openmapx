/** Portable platform preview data; these schemas confer no host authority. */
import z from "zod/v4";
import { platformConfigurationSchema } from "../../../services/platform-configuration";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z
  .string()
  .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
  .nullable();
const source = z.enum(["host", "database"]);
const url = z.url().max(2048);
export const adminPlatformPreviewInputSchema = z.strictObject({
  expectedCurrentRevisionId: revision,
  changes: platformConfigurationSchema,
});
export const adminPlatformConfirmationSchema = z.strictObject({
  domain: z.boolean(),
  dnsTls: z.boolean(),
  oauth: z.boolean(),
  passkeys: z.boolean(),
  alternateLogin: z.boolean(),
});
export const adminPlatformPreviewSchema = z.strictObject({
  version: z.literal(1),
  actorId: z.string().min(1).max(128),
  previewId: z.uuid(),
  authPolicyRevision: digest,
  sourceRevision: z.uuid(),
  expectedCurrentRevisionId: revision,
  configuration: platformConfigurationSchema,
  values: z.strictObject({
    domain: z.string().min(1).max(253),
    acmeEmail: z.email().max(320),
    releaseSelector: z.string().min(1).max(128),
    defaultRegion: z.string().max(128).nullable(),
    backupRetentionDays: z.number().int().min(1).max(36500),
  }),
  sources: z.strictObject({
    domain: source,
    acmeEmail: source,
    releaseSelector: source,
    defaultRegion: source,
    backupRetentionDays: source,
  }),
  affectedServiceIds: z.array(z.string().min(1).max(64)).max(256),
  oldOrigin: url,
  newOrigin: url,
  originConsumers: z.strictObject({
    routingHost: z.string().min(1).max(253),
    corsOrigin: url,
    authUrl: url,
    passkeyRpId: z.string().min(1).max(253),
    passkeyOrigin: z.string().max(2048),
    webApiUrl: url,
    tilesPublicUrl: url,
  }),
  requiredConfirmation: adminPlatformConfirmationSchema,
  warnings: z.array(z.string().max(512)).max(16),
  previewFingerprint: digest,
});
export const adminPlatformApplyInputSchema = z.strictObject({
  expectedCurrentRevisionId: revision,
  previewFingerprint: digest,
  confirmations: adminPlatformConfirmationSchema,
});
export type AdminPlatformPreview = z.infer<typeof adminPlatformPreviewSchema>;
