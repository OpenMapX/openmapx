import z from "zod/v4";
import { backupPrunePreviewSchema, backupPruneProofSchema } from "../../../ops/backup-prune";
import { type AdminOperation, adminCommonResponses, adminJson } from "../admin";
import { adminServiceAcceptedSchema, adminServiceIdempotencyHeadersSchema } from "./common";
export const adminBackupPruneInputSchema = z.strictObject({
  proof: backupPruneProofSchema,
  confirmation: z.literal("PRUNE EXPIRED BACKUPS"),
});
export const backupMaintenanceAdminOperations = {
  previewAdminBackupPrune: {
    method: "POST",
    path: "/api/admin/services/backups/prune/preview",
    auth: "admin",
    request: {},
    responses: {
      200: adminJson(backupPrunePreviewSchema),
      503: adminJson(z.strictObject({ error: z.string() })),
      ...adminCommonResponses,
    },
  },
  pruneAdminServiceBackups: {
    method: "POST",
    path: "/api/admin/services/backups/prune",
    auth: "admin",
    request: { headers: adminServiceIdempotencyHeadersSchema, body: adminBackupPruneInputSchema },
    responses: {
      202: adminJson(adminServiceAcceptedSchema),
      409: adminJson(z.strictObject({ error: z.string() })),
      503: adminJson(z.strictObject({ error: z.string() })),
      ...adminCommonResponses,
    },
  },
} as const satisfies Record<string, AdminOperation>;
