/** Fixed handoff data. A matching DTO never supplies target authority. */
import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
export const protectedConfigurationServiceIdSchema = z.enum([
  "postgis",
  "redis",
  "app-web",
  "app-api",
  "traefik",
  "ops-agent",
]);
export type ProtectedConfigurationServiceId = z.infer<typeof protectedConfigurationServiceIdSchema>;
/** Explicit reconciliation of already-saved protected settings, never a new image selection. */
export const protectedConfigurationReconcileIdsSchema = z
  .array(protectedConfigurationServiceIdSchema)
  .min(1)
  .max(6)
  .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id));
export const configurationHandoffModeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("configuration") }),
  z.strictObject({
    kind: z.literal("release"),
    releaseId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    manifestDigest: digest,
  }),
]);
export const configurationHandoffIntentSchema = z
  .strictObject({
    handoffId: z.uuid(),
    previewFingerprint: digest,
    serviceIds: z
      .array(id)
      .min(1)
      .max(64)
      .refine((ids) => ids.every((v, i) => i === 0 || ids[i - 1]! < v)),
    expectedImageIdentities: z.record(id, z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    mode: configurationHandoffModeSchema,
  })
  .superRefine((value, ctx) => {
    if (
      JSON.stringify(value).length > 24576 ||
      JSON.stringify(Object.keys(value.expectedImageIdentities).sort()) !==
        JSON.stringify(value.serviceIds) ||
      (value.mode.kind === "configuration" &&
        value.serviceIds.some((id) => !protectedConfigurationServiceIdSchema.safeParse(id).success))
    )
      ctx.addIssue({ code: "custom", message: "Invalid frozen handoff target/image set" });
  });
export type ConfigurationHandoffIntent = z.infer<typeof configurationHandoffIntentSchema>;
export const configurationHandoffPrepareOperationSchema =
  configurationHandoffIntentSchema.safeExtend({
    kind: z.literal("configurationHandoff.prepare"),
    maintenanceId: z.uuid(),
    candidateId: z.uuid(),
    planDigest: digest,
    expectedCurrentRevisionId: revision,
  });
/** What the configuration helper reports while it replaces protected services.
 * Only the helper writes it; the agent reads it once the helper container exited. */
export const handoffProgressSchema = z
  .strictObject({
    version: z.literal(1),
    maintenanceId: z.uuid(),
    handoffId: z.uuid(),
    phase: z.enum(["applying", "verifying", "applied", "cancelled", "failed"]),
    targets: z
      .array(
        z.strictObject({
          serviceId: id,
          phase: z.enum(["pending", "recreate_attempted", "verified"]),
          oldContainerId: z.string().regex(/^[a-f0-9]{64}$/),
          newContainerId: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          expectedImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        }),
      )
      .min(1)
      .max(64),
    updatedAt: z.iso.datetime(),
  })
  .refine(
    (value) =>
      new Set(value.targets.map((target) => target.serviceId)).size === value.targets.length,
  );
export type HandoffProgress = z.infer<typeof handoffProgressSchema>;
