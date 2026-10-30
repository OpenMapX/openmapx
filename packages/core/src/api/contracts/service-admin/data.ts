import z from "zod/v4";
import { dataInspectionResultSchema } from "../../../ops/data-inventory-records";
import { adminCountSchema, adminTimestampSchema } from "../admin";
import { adminServiceIdListSchema } from "./common";

export const adminServiceDataQuerySchema = z.strictObject({
  osmLimit: z.coerce.number().int().min(1).max(500).optional(),
  osmOffset: z.coerce.number().int().min(0).max(1000000).optional(),
});
export const adminServiceDataSchema = dataInspectionResultSchema.extend({
  fetchedAt: adminTimestampSchema,
});
export const adminServiceSelectionSchema = z.strictObject({
  source: z.enum(["env", "file", "default"]),
  selectedRoots: z.array(z.string()),
  requestedIds: z.array(z.string()),
  effectiveIds: z.array(z.string()),
  warnings: z.array(z.string()),
  missingIds: z.array(z.string()),
  envVarName: z.string(),
  envVarValue: z.string().nullable(),
  selectionFilePath: z.string(),
});
export const adminServiceSelectionSetSchema = z.strictObject({
  selectedRoots: adminServiceIdListSchema,
});
export const adminServiceSelectionUpdatedSchema = z.strictObject({
  ok: z.literal(true),
  revisionId: z.string(),
  summary: adminServiceSelectionSchema,
});
export const adminServiceBackupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const adminServiceBackupParamsSchema = z.strictObject({
  name: adminServiceBackupNameSchema,
});
export const adminServiceBackupSchema = z.strictObject({
  name: z.string(),
  createdAt: adminTimestampSchema,
  expiresAt: adminTimestampSchema.optional(),
  openmapxVersion: z.string().optional(),
  serviceCount: adminCountSchema,
  volumeCount: adminCountSchema,
  totalBytes: adminCountSchema,
  corrupt: z.literal(true).optional(),
  corruptReason: z.enum(["missing_manifest", "invalid_manifest", "unsafe_entry"]).optional(),
});
export const adminServiceBackupsSchema = z.strictObject({
  backups: z.array(adminServiceBackupSchema),
  warnings: z.array(z.string()),
  root: z.literal("ops-agent-managed"),
});
export const adminServiceBackupCreateSchema = z
  .strictObject({ name: adminServiceBackupNameSchema.or(z.string().trim().length(0)).optional() })
  .optional();
export const adminServiceBackupRestoreSchema = z
  .strictObject({
    serviceIds: adminServiceIdListSchema.optional(),
    stopRunning: z.boolean().optional(),
  })
  .optional();

export type AdminServiceData = z.infer<typeof adminServiceDataSchema>;
export type AdminServiceSelection = z.infer<typeof adminServiceSelectionSchema>;
export type AdminServiceSelectionSet = z.infer<typeof adminServiceSelectionSetSchema>;
export type AdminServiceSelectionUpdated = z.infer<typeof adminServiceSelectionUpdatedSchema>;
export type AdminServiceBackup = z.infer<typeof adminServiceBackupSchema>;
export type AdminServiceBackups = z.infer<typeof adminServiceBackupsSchema>;
export type AdminServiceBackupCreate = z.infer<typeof adminServiceBackupCreateSchema>;
export type AdminServiceBackupRestore = z.infer<typeof adminServiceBackupRestoreSchema>;
