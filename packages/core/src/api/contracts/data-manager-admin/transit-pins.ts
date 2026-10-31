import z from "zod/v4";
import {
  catalogActivateRequestSchema,
  catalogProposalCreateSchema,
  catalogReviewQuerySchema,
  catalogReviewSnapshotSchema,
  catalogValidateRequestSchema,
} from "../../../services/data-manager/contracts/catalog-review";
import { dataExecutionStatusSchema } from "../../../services/data-manager/contracts/executions";
import { type AdminOperation, adminCommonResponses, adminJson, httpErrorSchema } from "../admin";

const responses = {
  ...adminCommonResponses,
  404: adminJson(httpErrorSchema),
  409: adminJson(httpErrorSchema),
  422: adminJson(httpErrorSchema),
  503: adminJson(httpErrorSchema),
};
const headers = z.object({
  "idempotency-key": z.string().regex(/^opk1_t1_[0-9a-f]{14}_[A-Za-z0-9_-]{22}$/),
});
const params = z.strictObject({ proposalId: z.uuid() });
const accepted = z.strictObject({ jobId: z.uuid() });
export const transitPinOperations = {
  getAdminTransitPins: {
    method: "GET",
    path: "/api/admin/transit/pins",
    auth: "admin",
    request: { query: catalogReviewQuerySchema },
    responses: { ...responses, 200: adminJson(catalogReviewSnapshotSchema) },
  },
  proposeAdminTransitPins: {
    method: "POST",
    path: "/api/admin/transit/pins/proposals",
    auth: "admin",
    request: { headers, body: catalogProposalCreateSchema },
    responses: {
      ...responses,
      200: adminJson(
        z.strictObject({ proposalId: z.uuid(), generationId: z.string().regex(/^[a-f0-9]{64}$/) }),
      ),
    },
  },
  validateAdminTransitPins: {
    method: "POST",
    path: "/api/admin/transit/pins/proposals/:proposalId/validate",
    auth: "admin",
    request: { params, headers, body: catalogValidateRequestSchema },
    responses: { ...responses, 202: adminJson(accepted) },
  },
  activateAdminTransitPins: {
    method: "POST",
    path: "/api/admin/transit/pins/proposals/:proposalId/activate",
    auth: "admin",
    request: { params, headers, body: catalogActivateRequestSchema },
    responses: { ...responses, 202: adminJson(accepted) },
  },
  cancelAdminTransitPinExecution: {
    method: "DELETE",
    path: "/api/admin/transit/pins/executions/:id",
    auth: "admin",
    request: {
      params: z.strictObject({ id: z.uuid() }),
      body: z.strictObject({
        operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    },
    responses: { ...responses, 200: adminJson(dataExecutionStatusSchema) },
  },
  getAdminTransitPinExecution: {
    method: "GET",
    path: "/api/admin/transit/pins/executions/:id",
    auth: "admin",
    request: { params: z.strictObject({ id: z.uuid() }) },
    responses: { ...responses, 200: adminJson(dataExecutionStatusSchema) },
  },
} as const satisfies Record<string, AdminOperation>;
