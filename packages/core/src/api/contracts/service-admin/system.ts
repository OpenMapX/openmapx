import z from "zod/v4";
import { type AdminOperation, adminCommonResponses, adminJson } from "../admin";
import { adminServiceAcceptedSchema, adminServiceEmptyMutationSchema } from "./common";

export const ADMIN_SYSTEM_UPDATE_CONFIRMATION = "UPDATE OPENMAPX";
const releaseIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const adminSystemDeploymentSchema = z.strictObject({
  dockerAvailable: z.boolean(),
  composeRendered: z.boolean(),
  hostControlConfigured: z.boolean(),
  maintenanceReady: z.boolean(),
});
export const adminSystemImageSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  containerState: z.string(),
  runningImageId: z.string().nullable(),
  localImageId: z.string().nullable(),
  updateAvailable: z.boolean(),
  releaseMember: z.boolean(),
  status: z.enum(["up-to-date", "update-available", "not-running", "unknown"]),
});
export const adminSystemStatusSchema = z.strictObject({
  deployment: adminSystemDeploymentSchema,
  images: z.array(adminSystemImageSchema),
  release: z.strictObject({
    configuredSelector: z.string().optional(),
    /** The release the applied configuration pins, which the services run. */
    currentReleaseId: z.string().optional(),
    availableReleaseId: z.string().optional(),
    currentVersion: z.string().optional(),
    availableVersion: z.string().optional(),
    availableDigest: digestSchema.optional(),
  }),
});
export const adminSystemUpdateInputSchema = z.strictObject({
  confirmation: z.literal(ADMIN_SYSTEM_UPDATE_CONFIRMATION),
  createBackup: z.boolean().optional(),
  releaseId: releaseIdSchema,
  expectedDigest: digestSchema,
});
/** An active maintenance job (named when known) or host maintenance being unavailable. */
export const adminSystemConflictSchema = z.union([
  z.strictObject({ error: z.string(), jobId: z.string().optional() }),
  z.strictObject({ error: z.string(), deployment: adminSystemDeploymentSchema }),
]);
const maintenanceResponses = {
  200: adminJson(adminServiceAcceptedSchema),
  409: adminJson(adminSystemConflictSchema),
  ...adminCommonResponses,
};

export const systemAdminOperations = {
  getAdminSystemStatus: {
    method: "GET",
    path: "/api/admin/system",
    auth: "admin",
    responses: { 200: adminJson(adminSystemStatusSchema), ...adminCommonResponses },
  },
  checkAdminSystemUpdates: {
    method: "POST",
    path: "/api/admin/system/updates/check",
    auth: "admin",
    request: { body: adminServiceEmptyMutationSchema },
    responses: maintenanceResponses,
  },
  applyAdminSystemUpdate: {
    method: "POST",
    path: "/api/admin/system/updates/apply",
    auth: "admin",
    request: { body: adminSystemUpdateInputSchema },
    responses: maintenanceResponses,
  },
  runAdminSystemDiagnostics: {
    method: "POST",
    path: "/api/admin/system/diagnostics",
    auth: "admin",
    request: { body: adminServiceEmptyMutationSchema },
    responses: maintenanceResponses,
  },
} as const satisfies Record<string, AdminOperation>;

export type AdminSystemStatus = z.infer<typeof adminSystemStatusSchema>;
export type AdminSystemImage = z.infer<typeof adminSystemImageSchema>;
