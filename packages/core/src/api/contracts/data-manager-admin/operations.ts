import z from "zod/v4";
import {
  ambientEnabledRequestSchema,
  ambientGenerationRequestSchema,
  ambientPlacesStatusSchema,
  ambientRegionSchema,
} from "../../../services/data-manager/contracts/ambient";
import { acceptedSchema, okSchema } from "../../../services/data-manager/contracts/common";
import { uncachedResponseHeadersSchema } from "../../../services/data-manager/contracts/headers";
import {
  notablePlacesStatusSchema,
  searchIndexStatusSchema,
} from "../../../services/data-manager/contracts/indexes";
import { overtureStatusSchema } from "../../../services/data-manager/contracts/overture";
import {
  addTransitSourceRequestSchema,
  transitBumpResultSchema,
  transitConflictSchema,
  transitMutationRequestSchema,
  transitPreflightSelectionSchema,
  transitPreflightStaleSchema,
  transitProfileSchema,
  transitScopeRejectedSchema,
  transitSourceActionErrorSchema,
  transitSourceListSchema,
  transitSourceMutationResultSchema,
  transitSourcesQuerySchema,
  transitSyncAcceptedSchema,
  transitSyncPreflightSchema,
  transitSyncRequestSchema,
} from "../../../services/data-manager/contracts/transit";
import {
  adminCommonResponses as common,
  type DataManagerAdminOperation,
  httpErrorSchema,
  adminJson as json,
} from "./common";
import {
  providerHealthEntrySchema,
  providerHealthResponseSchema,
  providerResetResponseSchema,
} from "./providers";
import {
  roadConditionsPolicySnapshotSchema,
  transitCatalogQuerySchema,
  transitCatalogResponseSchema,
  transitFeedsQuerySchema,
  transitFeedsResponseSchema,
  transitJobDetailSchema,
  transitJobIdParamsSchema,
  transitJobsQuerySchema,
  transitJobsResponseSchema,
  transitStateSummarySchema,
} from "./transit";
import { transitCredentialOperations } from "./transit-credentials";
import { transitPinOperations } from "./transit-pins";

const service = "service" as const;
const admin = "admin" as const;
const idParams = z.strictObject({ id: z.string().min(1) });
const sourceParams = z.strictObject({ sourceId: z.string().min(1) });
export const adminSourceMutationRequestSchema = transitMutationRequestSchema.omit({
  triggeredBy: true,
});
export const adminAddTransitSourceRequestSchema = addTransitSourceRequestSchema.omit({
  triggeredBy: true,
});
export const adminTransitSyncRequestSchema = transitPreflightSelectionSchema.extend({
  preflightId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().max(200).optional(),
});
export const adminTransitBumpRequestSchema = z
  .strictObject({ branch: z.string().max(128).optional(), force: z.boolean().optional() })
  .optional();
const mutationResponses = {
  ...common,
  202: json(transitSourceMutationResultSchema),
  404: json(httpErrorSchema),
  409: json(z.union([httpErrorSchema, transitConflictSchema, transitSourceActionErrorSchema])),
};
const ambientAccepted = {
  ...common,
  202: json(acceptedSchema, uncachedResponseHeadersSchema),
  409: json(httpErrorSchema, uncachedResponseHeadersSchema),
  503: json(httpErrorSchema, uncachedResponseHeadersSchema),
};
const ambientUpdated = {
  ...common,
  200: json(okSchema, uncachedResponseHeadersSchema),
  409: json(httpErrorSchema, uncachedResponseHeadersSchema),
  503: json(httpErrorSchema, uncachedResponseHeadersSchema),
};
/** Application API operations. Service credentials, private acquisition and internal endpoints are not browser contracts. */
export const dataManagerAdminOperations = {
  ...transitCredentialOperations,
  ...transitPinOperations,
  getApiDataManagerRoadConditionsPolicy: {
    method: "GET",
    path: "/api/data-manager/road-conditions/policy",
    auth: service,
    responses: {
      ...common,
      200: json(roadConditionsPolicySnapshotSchema, uncachedResponseHeadersSchema),
    },
  },
  getApiDataManagerTransitSources: {
    method: "GET",
    path: "/api/data-manager/transit/sources",
    auth: service,
    request: { query: transitSourcesQuerySchema },
    responses: {
      ...common,
      200: json(transitSourceListSchema),
      404: json(httpErrorSchema),
      409: json(httpErrorSchema),
    },
  },
  getApiDataManagerTransitCatalog: {
    method: "GET",
    path: "/api/data-manager/transit/catalog",
    auth: service,
    request: { query: transitCatalogQuerySchema },
    responses: { ...common, 200: json(transitCatalogResponseSchema), 502: json(httpErrorSchema) },
  },
  getApiDataManagerTransitState: {
    method: "GET",
    path: "/api/data-manager/transit/state",
    auth: service,
    responses: { ...common, 200: json(transitStateSummarySchema) },
  },
  getApiDataManagerTransitFeeds: {
    method: "GET",
    path: "/api/data-manager/transit/feeds",
    auth: service,
    request: { query: transitFeedsQuerySchema },
    responses: { ...common, 200: json(transitFeedsResponseSchema) },
  },
  getApiDataManagerTransitJobs: {
    method: "GET",
    path: "/api/data-manager/transit/jobs",
    auth: service,
    request: { query: transitJobsQuerySchema },
    responses: { ...common, 200: json(transitJobsResponseSchema) },
  },
  getApiDataManagerTransitJobsId: {
    method: "GET",
    path: "/api/data-manager/transit/jobs/:id",
    auth: service,
    request: { params: transitJobIdParamsSchema },
    responses: { ...common, 200: json(transitJobDetailSchema), 404: json(httpErrorSchema) },
  },
  postApiDataManagerTransitSources: {
    method: "POST",
    path: "/api/data-manager/transit/sources",
    auth: service,
    request: { body: adminAddTransitSourceRequestSchema },
    responses: mutationResponses,
  },
  deleteApiDataManagerTransitSourcesSourceId: {
    method: "DELETE",
    path: "/api/data-manager/transit/sources/:sourceId",
    auth: service,
    request: { params: sourceParams, body: adminSourceMutationRequestSchema },
    responses: mutationResponses,
  },
  postApiDataManagerTransitSourcesSourceIdEnable: {
    method: "POST",
    path: "/api/data-manager/transit/sources/:sourceId/enable",
    auth: service,
    request: { params: sourceParams, body: adminSourceMutationRequestSchema },
    responses: mutationResponses,
  },
  postApiDataManagerTransitSourcesSourceIdDisable: {
    method: "POST",
    path: "/api/data-manager/transit/sources/:sourceId/disable",
    auth: service,
    request: { params: sourceParams, body: adminSourceMutationRequestSchema },
    responses: mutationResponses,
  },
  getApiDataManagerTransitProfile: {
    method: "GET",
    path: "/api/data-manager/transit/profile",
    auth: service,
    responses: { ...common, 200: json(transitProfileSchema), 503: json(httpErrorSchema) },
  },
  postApiDataManagerTransitSyncPreflight: {
    method: "POST",
    path: "/api/data-manager/transit/sync/preflight",
    auth: service,
    request: { body: transitPreflightSelectionSchema },
    responses: {
      ...common,
      200: json(transitSyncPreflightSchema),
      409: json(transitPreflightStaleSchema),
      422: json(httpErrorSchema),
      503: json(httpErrorSchema),
    },
  },
  postApiDataManagerTransitSync: {
    method: "POST",
    path: "/api/data-manager/transit/sync",
    auth: service,
    request: { body: adminTransitSyncRequestSchema },
    responses: {
      ...common,
      202: json(transitSyncAcceptedSchema),
      409: json(z.union([httpErrorSchema, transitConflictSchema, transitPreflightStaleSchema])),
      422: json(transitScopeRejectedSchema),
    },
  },
  postApiDataManagerTransitRestartMotis: {
    method: "POST",
    path: "/api/data-manager/transit/restart-motis",
    auth: service,
    responses: {
      ...common,
      200: json(z.strictObject({ ok: z.literal(true), status: z.literal("restart-initiated") })),
      503: json(httpErrorSchema),
    },
  },
  getApiDataManagerProviders: {
    method: "GET",
    path: "/api/data-manager/providers",
    auth: service,
    responses: {
      ...common,
      200: json(providerHealthResponseSchema, uncachedResponseHeadersSchema),
    },
  },
  getApiDataManagerProvidersId: {
    method: "GET",
    path: "/api/data-manager/providers/:id",
    auth: service,
    request: { params: idParams },
    responses: {
      ...common,
      200: json(providerHealthEntrySchema, uncachedResponseHeadersSchema),
      404: json(httpErrorSchema, uncachedResponseHeadersSchema),
    },
  },
  postApiDataManagerProvidersIdReset: {
    method: "POST",
    path: "/api/data-manager/providers/:id/reset",
    auth: admin,
    request: { params: idParams },
    responses: {
      ...common,
      200: json(providerResetResponseSchema, uncachedResponseHeadersSchema),
      503: json(httpErrorSchema, uncachedResponseHeadersSchema),
    },
  },
  postApiDataManagerTransitBumpTransitousRef: {
    method: "POST",
    path: "/api/data-manager/transit/bump-transitous-ref",
    auth: admin,
    request: { body: adminTransitBumpRequestSchema },
    responses: {
      ...common,
      200: json(transitBumpResultSchema),
      409: json(httpErrorSchema),
      502: json(httpErrorSchema),
    },
  },
  getApiDataManagerOvertureStatus: {
    method: "GET",
    path: "/api/data-manager/overture/status",
    auth: admin,
    responses: { ...common, 200: json(overtureStatusSchema), 404: json(httpErrorSchema) },
  },
  getApiDataManagerSearchIndexStatus: {
    method: "GET",
    path: "/api/data-manager/search-index/status",
    auth: admin,
    responses: { ...common, 200: json(searchIndexStatusSchema), 404: json(httpErrorSchema) },
  },
  getApiDataManagerNotablePlacesStatus: {
    method: "GET",
    path: "/api/data-manager/notable-places/status",
    auth: admin,
    responses: { ...common, 200: json(notablePlacesStatusSchema), 404: json(httpErrorSchema) },
  },
  getApiAdminAmbientPlacesStatus: {
    method: "GET",
    path: "/api/admin/ambient-places/status",
    auth: admin,
    responses: {
      ...common,
      200: json(ambientPlacesStatusSchema, uncachedResponseHeadersSchema),
      503: json(httpErrorSchema, uncachedResponseHeadersSchema),
    },
  },
  postApiAdminAmbientPlacesBuild: {
    method: "POST",
    path: "/api/admin/ambient-places/build",
    auth: admin,
    request: { body: ambientRegionSchema },
    responses: ambientAccepted,
  },
  postApiAdminAmbientPlacesResume: {
    method: "POST",
    path: "/api/admin/ambient-places/resume",
    auth: admin,
    request: { body: ambientGenerationRequestSchema },
    responses: ambientAccepted,
  },
  postApiAdminAmbientPlacesDiscard: {
    method: "POST",
    path: "/api/admin/ambient-places/discard",
    auth: admin,
    request: { body: ambientGenerationRequestSchema },
    responses: ambientUpdated,
  },
  postApiAdminAmbientPlacesEnabled: {
    method: "POST",
    path: "/api/admin/ambient-places/enabled",
    auth: admin,
    request: { body: ambientEnabledRequestSchema },
    responses: ambientUpdated,
  },
  postApiAdminAmbientPlacesRollback: {
    method: "POST",
    path: "/api/admin/ambient-places/rollback",
    auth: admin,
    responses: ambientUpdated,
  },
} as const satisfies Record<string, DataManagerAdminOperation>;
export type DataManagerAdminOperationKey = keyof typeof dataManagerAdminOperations;
