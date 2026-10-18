import z from "zod/v4";
import { dataManagerCoverageEvidencePageSchema } from "../../../coverage/schemas";
import * as a from "./ambient";
import {
  acceptedSchema,
  type DataManagerOperation,
  empty,
  httpErrorSchema,
  json,
  ndjson,
  okSchema,
  publicErrors,
  regionBodySchema,
  regionSchema,
  serviceErrors,
} from "./common";
import * as d from "./datasets";
import * as h from "./headers";
import * as i from "./indexes";
import * as f from "./offline";
import * as o from "./overture";
import { trafficApplicationSnapshotSchema } from "./traffic";
import * as t from "./transit";

const service = "service" as const;
const sourceParams = z.strictObject({ sourceId: z.string().min(1) });
const sourceMutationErrors = {
  ...serviceErrors,
  404: json(httpErrorSchema),
  409: json(z.union([httpErrorSchema, t.transitConflictSchema])),
};
const offlineErrors = {
  ...serviceErrors,
  400: json(z.union([httpErrorSchema, f.offlinePackageErrorSchema])),
  404: json(httpErrorSchema),
};
const principalRequestError = {
  headers: {
    ok: false,
    errorCode: "invalid-principal",
    errorMessage: "Exactly one valid offline package principal is required",
  },
} as const;
const packageArchive = {
  request: { params: f.offlinePackageParamsSchema, headers: f.offlineArchiveHeadersSchema },
};
export const coverageEvidenceQuerySchema = z
  .strictObject({
    snapshotId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .optional(),
    offset: z.coerce.number().int().min(0).max(10_000_000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((v) => !v.offset || !!v.snapshotId, "snapshotId is required for continuation pages");
/** The sole method/path/status authority for the internal service and its generated SDK. */
export const dataManagerOperations = {
  getLive: {
    method: "GET",
    path: "/live",
    auth: "public",
    responses: { ...publicErrors, 200: json(okSchema) },
  },
  getStatus: {
    method: "GET",
    path: "/status",
    auth: "public",
    responses: {
      ...publicErrors,
      200: json(d.readyStatusSchema),
      503: json(d.unreadyStatusSchema),
    },
  },
  getDatasets: {
    method: "GET",
    path: "/datasets",
    auth: service,
    responses: { ...serviceErrors, 200: json(d.datasetsSchema) },
  },
  reloadDatasets: {
    method: "POST",
    path: "/datasets/reload",
    auth: service,
    responses: { ...serviceErrors, 200: json(d.reloadDatasetsSchema) },
  },
  downloadFonts: {
    method: "POST",
    path: "/download/fonts",
    auth: service,
    responses: { ...serviceErrors, 200: json(okSchema) },
  },
  link: {
    method: "POST",
    path: "/link",
    auth: service,
    request: { body: d.linkRequestSchema },
    responses: { ...serviceErrors, 200: json(d.linkResultSchema) },
  },
  downloadOsm: {
    method: "POST",
    path: "/download/osm",
    auth: service,
    request: { body: regionBodySchema },
    responses: {
      ...serviceErrors,
      200: ndjson(d.downloadOsmEventSchema, h.ndjsonResponseHeadersSchema),
    },
  },
  convertOverpass: {
    method: "POST",
    path: "/convert/overpass",
    auth: service,
    request: { body: z.strictObject({ region: regionSchema.optional() }).optional() },
    responses: {
      ...serviceErrors,
      200: ndjson(d.convertOverpassEventSchema, h.ndjsonResponseHeadersSchema),
    },
  },
  getSearchIndexStatus: {
    method: "GET",
    path: "/search-index/status",
    auth: service,
    responses: {
      ...serviceErrors,
      200: json(i.searchIndexStatusSchema),
      404: json(httpErrorSchema),
    },
  },
  buildSearchIndex: {
    method: "POST",
    path: "/search-index/build",
    auth: service,
    request: { body: regionBodySchema },
    responses: {
      ...serviceErrors,
      200: ndjson(i.searchIndexEventSchema, h.ndjsonResponseHeadersSchema),
    },
  },
  getNotablePlacesStatus: {
    method: "GET",
    path: "/notable-places/status",
    auth: service,
    responses: {
      ...serviceErrors,
      200: json(i.notablePlacesStatusSchema),
      404: json(httpErrorSchema),
    },
  },
  buildNotablePlaces: {
    method: "POST",
    path: "/notable-places/build",
    auth: service,
    responses: {
      ...serviceErrors,
      200: ndjson(i.notablePlacesEventSchema, h.ndjsonResponseHeadersSchema),
    },
  },
  getOvertureStatus: {
    method: "GET",
    path: "/overture/status",
    auth: service,
    responses: { ...serviceErrors, 200: json(o.overtureStatusSchema), 404: json(httpErrorSchema) },
  },
  pullOverture: {
    method: "POST",
    path: "/overture/pull",
    auth: service,
    request: { body: regionBodySchema },
    responses: {
      ...serviceErrors,
      200: ndjson(o.overturePullEventSchema, h.ndjsonResponseHeadersSchema),
    },
  },
  syncOverture: {
    method: "POST",
    path: "/overture/sync",
    auth: service,
    request: { body: regionBodySchema },
    responses: {
      ...serviceErrors,
      200: ndjson(o.overtureSyncEventSchema, h.ndjsonResponseHeadersSchema),
    },
  },
  ingestOverture: {
    method: "POST",
    path: "/overture/ingest",
    auth: service,
    request: { body: regionBodySchema },
    responses: {
      ...serviceErrors,
      200: ndjson(o.overtureSimpleEventSchema, h.ndjsonResponseHeadersSchema),
    },
  },
  extractOverture: {
    method: "POST",
    path: "/overture/extract",
    auth: service,
    request: { body: regionBodySchema },
    responses: {
      ...serviceErrors,
      200: ndjson(o.overtureSimpleEventSchema, h.ndjsonResponseHeadersSchema),
    },
  },
  conflateOverture: {
    method: "POST",
    path: "/overture/conflate",
    auth: service,
    request: { body: regionBodySchema.extend({ restart: z.boolean().optional() }) },
    responses: {
      ...serviceErrors,
      200: ndjson(o.overtureConflateEventSchema, h.ndjsonResponseHeadersSchema),
    },
  },
  getTransitProfile: {
    method: "GET",
    path: "/transit/profile",
    auth: service,
    responses: { ...serviceErrors, 200: json(t.transitProfileSchema) },
  },
  getTransitCatalog: {
    method: "GET",
    path: "/transit/catalog",
    auth: service,
    responses: {
      ...serviceErrors,
      200: json(t.transitCatalogSchema),
      400: json(httpErrorSchema),
      404: json(httpErrorSchema),
      409: json(httpErrorSchema),
    },
  },
  getTransitSources: {
    method: "GET",
    path: "/transit/sources",
    auth: service,
    request: { query: t.transitSourcesQuerySchema },
    responses: {
      ...serviceErrors,
      200: json(t.transitSourceListSchema),
      404: json(httpErrorSchema),
      409: json(httpErrorSchema),
    },
  },
  addTransitSource: {
    method: "POST",
    path: "/transit/sources",
    auth: service,
    request: { body: t.addTransitSourceRequestSchema },
    responses: { ...sourceMutationErrors, 202: json(t.transitSourceMutationResultSchema) },
  },
  removeTransitSource: {
    method: "DELETE",
    path: "/transit/sources/:sourceId",
    auth: service,
    request: { params: sourceParams, body: t.transitMutationRequestSchema },
    responses: { ...sourceMutationErrors, 202: json(t.transitSourceMutationResultSchema) },
  },
  enableTransitSource: {
    method: "POST",
    path: "/transit/sources/:sourceId/enable",
    auth: service,
    request: { params: sourceParams, body: t.transitMutationRequestSchema },
    responses: { ...sourceMutationErrors, 202: json(t.transitSourceMutationResultSchema) },
  },
  preflightTransit: {
    method: "POST",
    path: "/transit/preflight",
    auth: service,
    request: { body: t.transitPreflightRequestSchema },
    responses: {
      ...serviceErrors,
      200: json(t.transitPreflightSchema.extend({ ok: z.literal(true) })),
      422: json(t.transitPreflightSchema.extend({ ok: z.literal(false) })),
    },
  },
  syncTransit: {
    method: "POST",
    path: "/transit/sync",
    auth: service,
    request: { body: t.transitSyncRequestSchema },
    responses: {
      ...serviceErrors,
      202: json(t.transitSyncAcceptedSchema),
      409: json(t.transitConflictSchema),
      422: json(t.transitScopeRejectedSchema),
    },
  },
  restartMotis: {
    method: "POST",
    path: "/transit/restart-motis",
    auth: service,
    responses: {
      ...serviceErrors,
      200: json(z.strictObject({ ok: z.literal(true), status: z.literal("restart-initiated") })),
      503: json(httpErrorSchema),
    },
  },
  proposeTransitBump: {
    method: "POST",
    path: "/transit/bump",
    auth: service,
    request: { body: t.transitBumpRequestSchema },
    responses: {
      ...serviceErrors,
      200: json(t.transitBumpResultSchema),
      409: json(httpErrorSchema),
      502: json(httpErrorSchema),
    },
  },
  approveTransitBump: {
    method: "POST",
    path: "/transit/bump/approve",
    auth: service,
    request: { body: t.transitApproveRequestSchema },
    responses: {
      ...serviceErrors,
      200: json(t.transitApprovalSchema),
      404: json(httpErrorSchema),
      422: json(t.transitApprovalMismatchSchema),
    },
  },
  bakePredictedTraffic: {
    method: "POST",
    path: "/traffic/predicted/bake",
    auth: service,
    responses: {
      ...serviceErrors,
      202: json(acceptedSchema),
      409: json(httpErrorSchema),
      501: json(httpErrorSchema),
    },
  },
  getAppliedTrafficConditions: {
    method: "GET",
    path: "/traffic/conditions/applied",
    auth: service,
    responses: {
      ...serviceErrors,
      200: json(trafficApplicationSnapshotSchema, h.uncachedResponseHeadersSchema),
      501: json(httpErrorSchema),
    },
  },
  getCoverageEvidence: {
    method: "GET",
    path: "/coverage/evidence",
    auth: service,
    request: { query: coverageEvidenceQuerySchema },
    responses: {
      ...serviceErrors,
      200: json(dataManagerCoverageEvidencePageSchema, h.coverageResponseHeadersSchema),
      409: json(httpErrorSchema, h.coverageResponseHeadersSchema),
      503: json(httpErrorSchema, h.coverageResponseHeadersSchema),
    },
  },
  getAmbientPlacesStatus: {
    method: "GET",
    path: "/ambient-places/status",
    auth: service,
    responses: { ...serviceErrors, 200: json(a.ambientPlacesStatusSchema) },
  },
  buildAmbientPlaces: {
    method: "POST",
    path: "/ambient-places/build",
    auth: service,
    request: { body: a.ambientRegionSchema },
    responses: { ...serviceErrors, 202: json(acceptedSchema), 409: json(httpErrorSchema) },
  },
  resumeAmbientPlaces: {
    method: "POST",
    path: "/ambient-places/resume",
    auth: service,
    request: { body: a.ambientGenerationRequestSchema },
    responses: { ...serviceErrors, 202: json(acceptedSchema), 409: json(httpErrorSchema) },
  },
  discardAmbientPlaces: {
    method: "POST",
    path: "/ambient-places/discard",
    auth: service,
    request: { body: a.ambientGenerationRequestSchema },
    responses: { ...serviceErrors, 200: json(okSchema), 409: json(httpErrorSchema) },
  },
  setAmbientPlacesEnabled: {
    method: "POST",
    path: "/ambient-places/enabled",
    auth: service,
    request: { body: a.ambientEnabledRequestSchema },
    responses: { ...serviceErrors, 200: json(okSchema), 409: json(httpErrorSchema) },
  },
  rollbackAmbientPlaces: {
    method: "POST",
    path: "/ambient-places/rollback",
    auth: service,
    responses: { ...serviceErrors, 200: json(okSchema), 409: json(httpErrorSchema) },
  },
  getOfflinePackageCapability: {
    method: "GET",
    path: "/offline/packages/capability",
    auth: service,
    responses: { ...serviceErrors, 200: json(f.offlinePackageCapabilitySchema) },
  },
  prepareOfflinePackage: {
    method: "POST",
    path: "/offline/packages/prepare",
    auth: service,
    request: { body: f.offlinePackageRequestSchema, headers: f.offlinePrincipalHeadersSchema },
    requestErrors: principalRequestError,
    responses: {
      ...offlineErrors,
      200: json(f.offlinePackageReadySchema),
      202: json(f.offlinePackagePreparingSchema),
      400: json(
        z.union([httpErrorSchema, f.offlinePackageErrorSchema, f.offlinePackageUnsuccessfulSchema]),
      ),
      409: json(f.offlinePackageUnsuccessfulSchema),
      429: json(f.offlinePackageErrorSchema, h.retryAfterHeadersSchema),
      503: json(f.offlinePackageErrorSchema),
    },
  },
  getOfflinePackageJob: {
    method: "GET",
    path: "/offline/packages/jobs/:jobId",
    auth: service,
    request: { params: f.offlineJobParamsSchema, headers: f.offlinePrincipalHeadersSchema },
    requestErrors: principalRequestError,
    responses: { ...offlineErrors, 200: json(f.offlinePackagePreparationSchema) },
  },
  getOfflinePackageManifest: {
    method: "GET",
    path: "/offline/packages/:packageId/manifest",
    auth: service,
    request: { params: f.offlinePackageParamsSchema },
    responses: { ...offlineErrors, 200: json(f.offlineMapPackageManifestSchema) },
  },
  getOfflineGlyphCatalog: {
    method: "GET",
    path: "/offline/packages/glyphs/:version/catalog.json",
    auth: service,
    request: { params: f.offlineGlyphVersionParamsSchema },
    responses: {
      ...offlineErrors,
      200: json(f.offlineGlyphCatalogSchema, h.immutableCacheHeadersSchema),
    },
  },
  getOfflineGlyph: {
    method: "GET",
    path: "/offline/packages/glyphs/:version/:fontstack/:range.pbf",
    auth: service,
    request: { params: f.offlineGlyphParamsSchema },
    responses: {
      ...offlineErrors,
      200: {
        kind: "raw",
        contentTypes: ["application/x-protobuf"],
        headers: h.glyphResponseHeadersSchema,
      },
    },
  },
  headOfflineGlyph: {
    method: "HEAD",
    path: "/offline/packages/glyphs/:version/:fontstack/:range.pbf",
    auth: service,
    request: { params: f.offlineGlyphParamsSchema },
    responses: {
      200: { ...empty, headers: h.glyphResponseHeadersSchema },
      400: empty,
      401: empty,
      404: empty,
      500: empty,
    },
  },
  getOfflinePackageArchive: {
    method: "GET",
    path: "/offline/packages/:packageId/archive",
    auth: service,
    ...packageArchive,
    responses: {
      ...offlineErrors,
      200: {
        kind: "raw",
        contentTypes: ["application/vnd.pmtiles"],
        headers: h.archiveResponseHeadersSchema,
      },
      206: {
        kind: "raw",
        contentTypes: ["application/vnd.pmtiles"],
        headers: h.partialArchiveResponseHeadersSchema,
      },
      416: { ...empty, headers: h.unsatisfiableArchiveResponseHeadersSchema },
    },
  },
  headOfflinePackageArchive: {
    method: "HEAD",
    path: "/offline/packages/:packageId/archive",
    auth: service,
    ...packageArchive,
    responses: {
      200: { ...empty, headers: h.archiveResponseHeadersSchema },
      206: { ...empty, headers: h.partialArchiveResponseHeadersSchema },
      400: empty,
      401: empty,
      404: empty,
      416: { ...empty, headers: h.unsatisfiableArchiveResponseHeadersSchema },
      500: empty,
    },
  },
  getTransitOperatorFeed: {
    method: "GET",
    path: "/internal/transit/operator-feed/:handle",
    auth: "capability",
    request: { params: z.strictObject({ handle: z.string().regex(/^[a-f0-9]{64}$/i) }) },
    responses: {
      ...serviceErrors,
      200: { kind: "raw", contentTypes: ["*/*"], headers: h.relaySuccessResponseHeadersSchema },
      410: json(httpErrorSchema, h.relayResponseHeadersSchema),
      502: json(httpErrorSchema, h.relayResponseHeadersSchema),
    },
  },
} as const satisfies Record<string, DataManagerOperation>;
export type DataManagerOperationKey = keyof typeof dataManagerOperations;
export type DataManagerCoverageEvidencePage = z.infer<typeof dataManagerCoverageEvidencePageSchema>;
