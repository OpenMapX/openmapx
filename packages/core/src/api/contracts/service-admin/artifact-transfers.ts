import z from "zod/v4";
import { transferPurposeSchema, transferStageSchema } from "../../../ops/artifact-transfer";
import { type AdminOperation, adminBytes, adminJson, httpErrorSchema } from "../admin";

const params = z.strictObject({ stageId: z.uuid() });
export const adminTransferCreateSchema = z.strictObject({
  purpose: transferPurposeSchema,
  direction: z.literal("upload"),
  declaredBytes: z.number().safe().int().nonnegative(),
  expectedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const adminTransferPageSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().safe().int().nonnegative().max(1_000_000).default(0),
});
export const artifactDownloadHeadersSchema = z.object({
  "content-type": z.literal("application/octet-stream"),
  "content-length": z.string().regex(/^(0|[1-9][0-9]*)$/),
  "content-disposition": z.literal('attachment; filename="openmapx-artifact.tar"'),
  "x-artifact-sha256": z.string().regex(/^[a-f0-9]{64}$/),
  "cache-control": z.literal("no-store"),
  "x-content-type-options": z.literal("nosniff"),
});
const errors = {
  400: adminJson(httpErrorSchema),
  401: adminJson(httpErrorSchema),
  403: adminJson(httpErrorSchema),
  404: adminJson(httpErrorSchema),
  409: adminJson(httpErrorSchema),
  410: adminJson(httpErrorSchema),
  413: adminJson(httpErrorSchema),
  415: adminJson(httpErrorSchema),
  422: adminJson(httpErrorSchema),
  429: adminJson(httpErrorSchema),
  500: adminJson(httpErrorSchema),
  503: adminJson(httpErrorSchema),
  507: adminJson(httpErrorSchema),
};
export const artifactTransferAdminOperations = {
  validateAdminArtifactTransfer: {
    method: "POST",
    path: "/api/admin/artifact-transfers/:stageId/validate",
    auth: "admin",
    request: {
      params,
      headers: z.object({
        "idempotency-key": z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/),
      }),
    },
    responses: {
      202: adminJson(z.strictObject({ ok: z.literal(true), jobId: z.uuid() })),
      ...errors,
    },
  },
  listAdminArtifactTransfers: {
    method: "GET",
    path: "/api/admin/artifact-transfers",
    auth: "admin",
    request: { query: adminTransferPageSchema },
    responses: {
      200: adminJson(
        z.strictObject({
          items: z.array(transferStageSchema).max(100),
          total: z.number().safe().int().nonnegative(),
          limit: z.number().int(),
          offset: z.number().int(),
        }),
      ),
      ...errors,
    },
  },
  createAdminArtifactTransfer: {
    method: "POST",
    path: "/api/admin/artifact-transfers",
    auth: "admin",
    request: {
      body: adminTransferCreateSchema,
      headers: z.object({ "idempotency-key": z.string().min(1).max(128) }),
    },
    responses: { 200: adminJson(transferStageSchema), ...errors },
  },
  getAdminArtifactTransfer: {
    method: "GET",
    path: "/api/admin/artifact-transfers/:stageId",
    auth: "admin",
    request: { params },
    responses: { 200: adminJson(transferStageSchema), ...errors },
  },
  deleteAdminArtifactTransfer: {
    method: "DELETE",
    path: "/api/admin/artifact-transfers/:stageId",
    auth: "admin",
    request: { params },
    responses: { 200: adminJson(z.strictObject({ deleted: z.literal(true) })), ...errors },
  },
  uploadAdminArtifactTransferContent: {
    method: "PUT",
    path: "/api/admin/artifact-transfers/:stageId/content",
    auth: "admin",
    request: { params },
    requestBody: { kind: "bytes", mediaType: "application/octet-stream" },
    responses: { 200: adminJson(transferStageSchema), ...errors },
  },
  downloadAdminArtifactTransferContent: {
    method: "GET",
    path: "/api/admin/artifact-transfers/:stageId/content",
    auth: "admin",
    request: { params },
    responses: {
      200: adminBytes("application/octet-stream", artifactDownloadHeadersSchema, true),
      ...errors,
    },
  },
} as const satisfies Record<string, AdminOperation>;
