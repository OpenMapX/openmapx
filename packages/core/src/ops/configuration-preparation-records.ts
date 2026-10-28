/** Portable bounded candidate records; parsing creates no authority. */
import { z } from "zod";
import { platformConfigurationSchema } from "../services/platform-configuration";
import { coordinatorLifecycleMetadataSchema } from "./coordinator-lifecycle-records";

const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const coordinatorModeSchema = z.enum(["ensure-running", "require-running"]);
export const configurationSourcesInspectionSchema = z
  .strictObject({
    revisionId: revision.nullable(),
    platform: platformConfigurationSchema.optional(),
    sourceRevision: z.uuid(),
    services: z
      .array(
        z.strictObject({
          serviceId: id,
          fields: z
            .array(
              z.strictObject({
                key,
                source: z.enum(["host", "none"]),
                envVar: z
                  .string()
                  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
                  .optional(),
              }),
            )
            .max(128),
        }),
      )
      .max(256),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024);
export type ConfigurationSourcesInspection = z.infer<typeof configurationSourcesInspectionSchema>;
export const configurationHardlinksPreviewSchema = z.strictObject({
  entries: z.number().int().min(0).max(256),
  requiredServiceIds: z.array(id).max(256),
  coordinatorState: z.enum(["not_required", "running", "stopped", "disabled", "unavailable"]),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ConfigurationHardlinksPreview = z.infer<typeof configurationHardlinksPreviewSchema>;

export const preparedConfigurationRecordSchema = z.strictObject({
  version: z.literal(1),
  candidateId: z.uuid(),
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  operation: z.unknown(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedSourceRevision: z.uuid(),
  sealed: z.string().max(699052),
  privateOverlay: z.unknown(),
  apiJobId: z.uuid(),
  actorId: z.string().min(1).max(256),
  parentOperationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  parentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  parentDeadlineAt: z.number().int().nonnegative().safe(),
  affectedServiceIds: z.array(id).max(256),
  apiFollowUp: z
    .enum([
      "none",
      "service-apply",
      "integration-reload",
      "coordinator-apply",
      "coordinator-update",
    ])
    .optional(),
  privateCoordinatorLifecycle: coordinatorLifecycleMetadataSchema.optional(),
  privateCoordinatorSource: configurationSourcesInspectionSchema.optional(),
  // Exact current DM credential persistence inputs retained before its helper
  // prerequisite. Recovery never regenerates row IDs, encryption or a seal.
  privateMaintenancePreparation: z
    .strictObject({
      version: z.literal(1),
      source: configurationSourcesInspectionSchema,
      serviceSecrets: z
        .array(
          z.strictObject({
            id: z.uuid(),
            serviceId: z.literal("data-manager"),
            key,
            ciphertext: z.string().max(350000),
            iv: z.string().max(64),
            tag: z.string().max(64),
            createdAt: z.iso.datetime(),
            updatedAt: z.iso.datetime(),
            updatedBy: z.string().max(256).nullable(),
          }),
        )
        .max(128),
    })
    .optional(),
  // Private authenticated recovery data, counted in the existing 768KiB cell.
  // No raw process environment, backend/provider objects or new authority.
  privateIntegrationReload: z
    .strictObject({
      version: z.literal(1),
      services: z.array(z.unknown()).max(256),
      integrations: z
        .array(
          z.strictObject({
            id,
            directory: z.string().min(1).max(4096),
            manifest: z.unknown(),
            isBuiltIn: z.boolean(),
          }),
        )
        .max(256),
      values: z.record(
        id,
        z.record(
          key,
          z.strictObject({
            value: z.unknown(),
            source: z.enum(["default", "database", "vault", "config.json", "env"]),
          }),
        ),
      ),
      bindings: z.record(id, z.record(z.string().min(1).max(128), id)).optional(),
      legacyImport: z
        .strictObject({
          version: z.literal(1),
          kind: z.literal("legacy-integration-config"),
          integrationIds: z.array(id).min(1).max(256),
          changedIntegrationIds: z.array(id).min(1).max(256),
        })
        .optional(),
    })
    .optional(),
  maintenanceId: z.uuid().nullable(),
  prepareOperationKey: z
    .string()
    .regex(/^opk1_[A-Za-z0-9_-]{16,64}$/)
    .nullable(),
  coordinatorPrerequisite: z
    .strictObject({
      stepAddress: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
      operation: z.strictObject({
        kind: z.literal("service.start"),
        serviceId: z.literal("data-manager"),
        expectedConfigurationRevisionId: revision,
      }),
      root: z.strictObject({
        operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
        requestedDeadlineAt: z.number().int().nonnegative().safe(),
        parent: z.strictObject({
          operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          deadlineAt: z.number().int().nonnegative().safe(),
        }),
      }),
    })
    .nullable()
    .optional(),
});
export type PreparedConfigurationRecord = z.infer<typeof preparedConfigurationRecordSchema>;
