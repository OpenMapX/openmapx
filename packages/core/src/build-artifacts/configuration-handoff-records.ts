/** Versioned helper journal data. Decoding confers neither a lease nor forward
 * authority; producers and observers join these to the original signed grant. */
import { z } from "zod";
import { configurationHandoffPrepareOperationSchema } from "../ops/configuration-handoff-records";
import { executionRefSchema } from "../ops/execution-ref";
import { configurationReleaseSnapshotSchema } from "./configuration-release-snapshot";
import { controlOriginSchema } from "./control-records";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  containerId = z.string().regex(/^[a-f0-9]{64}$/),
  time = z.number().int().nonnegative().safe();
export const configurationHandoffHelperBodySchema = z.strictObject({
  kind: z.literal("configuration-helper"),
  handoffId: z.uuid(),
  intentDigest: digest,
});
export const configurationHandoffIntentRecordSchema = z
  .strictObject({
    version: z.literal(1),
    installationId: z.uuid(),
    origin: controlOriginSchema,
    ownerPrepare: executionRefSchema,
    preparer: executionRefSchema,
    helper: executionRefSchema,
    operation: configurationHandoffPrepareOperationSchema,
    admittedAt: time,
    requestedDeadlineAt: time,
    helperPublicKey: z
      .string()
      .min(32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    sourceDigest: digest,
    environmentNames: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      )
      .max(256)
      .refine((names) => Buffer.byteLength(JSON.stringify(names)) <= 8192)
      .refine((names) => names.every((name, index) => index === 0 || names[index - 1]! < name)),
    preparerAdmissionDigest: digest,
    ownerCertificateDigest: digest,
    leaseId: z.uuid(),
    delegationId: z.uuid(),
    assertion: z.string().min(1).max(4096),
    helperContainerName: z.string().regex(/^openmapx-configuration-handoff-[a-f0-9-]{36}$/),
    preparedAt: time,
    release: configurationReleaseSnapshotSchema.optional(),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65536)
  .superRefine((value, context) => {
    const { mode } = value.operation;
    if (
      (mode.kind === "release") !== (value.release !== undefined) ||
      (mode.kind === "release" &&
        value.release &&
        (mode.releaseId !== value.release.releaseId ||
          mode.manifestDigest !== value.release.manifestDigest ||
          value.operation.serviceIds.some(
            (id) => !Object.hasOwn(value.release!.serviceImages, id),
          )))
    )
      context.addIssue({
        code: "custom",
        message: "Original checked release handoff snapshot required",
      });
  });
export const configurationHandoffProgressSchema = z
  .strictObject({
    version: z.literal(1),
    intentDigest: digest,
    sequence: z.number().int().min(0).max(2048),
    phase: z.enum([
      "prepared",
      "launch_attempted",
      "launched",
      "draining",
      "applying",
      "verifying",
      "applied",
      "rolled_back",
      "failed",
      "recovery_required",
    ]),
    launch: z.strictObject({
      state: z.enum(["not_attempted", "attempted", "confirmed"]),
      containerId: containerId.nullable(),
    }),
    targets: z
      .array(
        z.strictObject({
          serviceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
          phase: z.enum([
            "pending",
            "pull_attempted",
            "pulled",
            "recreate_attempted",
            "verified",
            "restore_attempted",
            "restored",
            "unknown",
          ]),
          oldContainerId: containerId,
          newContainerId: containerId.nullable(),
          expectedImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        }),
      )
      .min(1)
      .max(64),
    updatedAt: time,
    completedAt: time.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      Buffer.byteLength(JSON.stringify(value)) > 65536 ||
      new Set(value.targets.map((target) => target.serviceId)).size !== value.targets.length ||
      (value.launch.state === "confirmed") !== (value.launch.containerId !== null) ||
      (value.completedAt !== null && value.completedAt > value.updatedAt) ||
      (["applied", "rolled_back"].includes(value.phase) &&
        (value.completedAt === null ||
          value.launch.state !== "confirmed" ||
          value.targets.some(
            (target) =>
              target.phase !== (value.phase === "applied" ? "verified" : "restored") ||
              !target.newContainerId,
          )))
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent configuration helper progress" });
  });
export type ConfigurationHandoffIntentRecord = z.infer<
  typeof configurationHandoffIntentRecordSchema
>;
export type ConfigurationHandoffProgress = z.infer<typeof configurationHandoffProgressSchema>;
export const configurationHandoffWorkerRecordSchema = configurationHandoffProgressSchema
  .safeExtend({
    execution: executionRefSchema,
    preparationDigest: digest,
    observations: z
      .array(
        z.strictObject({
          serviceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
          checksDigest: digest,
          detailsDigest: digest,
        }),
      )
      .max(64),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65536)
  .refine(
    (value) =>
      new Set(value.observations.map((item) => item.serviceId)).size === value.observations.length,
  )
  .refine(
    (value) =>
      value.phase !== "applied" ||
      (value.observations.length === value.targets.length &&
        value.targets.every((target) =>
          value.observations.some((item) => item.serviceId === target.serviceId),
        )),
  );
export type ConfigurationHandoffWorkerRecord = z.infer<
  typeof configurationHandoffWorkerRecordSchema
>;
export const configurationHandoffRecordDomains = {
  intent: "openmapx-configuration-handoff-intent-v1",
  progress: "openmapx-configuration-handoff-progress-v1",
  completion: "openmapx-configuration-handoff-completion-v1",
} as const;
export const configurationHandoffRecordName = (
  id: string,
  kind: "intent" | "progress" | "completion",
) => `configuration-handoff-${z.uuid().parse(id)}.${kind}.json`;
