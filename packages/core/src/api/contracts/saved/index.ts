import z from "zod/v4";
import { EXPORT_CONTENT_TYPE } from "../../../saved-place-export";
import { httpErrorSchema, json } from "../../../services/data-manager/contracts/common";
import { authenticationRetryAfterHeadersSchema } from "../../../services/data-manager/contracts/headers";
import type { ApiOperation } from "../operation";
import * as s from "./schemas";

export * from "./schemas";

const common = {
  400: json(httpErrorSchema),
  401: json(httpErrorSchema),
  403: json(httpErrorSchema),
  404: json(httpErrorSchema),
  413: json(httpErrorSchema),
  415: json(httpErrorSchema),
  429: json(
    z.union([
      httpErrorSchema,
      z.strictObject({ error: z.string(), retryAfter: z.number().int().nonnegative() }),
    ]),
    authenticationRetryAfterHeadersSchema,
  ),
  500: json(httpErrorSchema),
};
const ok = { ...common, 200: json(s.savedOkSchema) };
export const savedOperations = {
  listSavedLists: {
    method: "GET",
    path: "/api/saved/lists",
    auth: "session",
    responses: { ...common, 200: json(s.savedListsResponseSchema) },
  },
  createSavedList: {
    method: "POST",
    path: "/api/saved/lists",
    auth: "session",
    request: { body: s.savedCreateListSchema },
    responses: { ...common, 200: json(s.savedListCreatedSchema) },
  },
  importSavedPlaces: {
    method: "POST",
    path: "/api/saved/lists/import",
    auth: "session",
    request: { body: s.savedImportSchema },
    responses: { ...common, 200: json(s.savedImportResultSchema) },
  },
  updateSavedList: {
    method: "PATCH",
    path: "/api/saved/lists/:id",
    auth: "session",
    request: { params: s.savedIdParamsSchema, body: s.savedUpdateListSchema },
    responses: ok,
  },
  deleteSavedList: {
    method: "DELETE",
    path: "/api/saved/lists/:id",
    auth: "session",
    request: { params: s.savedIdParamsSchema },
    responses: ok,
  },
  listSavedListPlaces: {
    method: "GET",
    path: "/api/saved/lists/:id/places",
    auth: "session",
    request: { params: s.savedIdParamsSchema },
    responses: { ...common, 200: json(s.savedPlacesResponseSchema) },
  },
  createSavedPlace: {
    method: "POST",
    path: "/api/saved/lists/:id/places",
    auth: "session",
    request: { params: s.savedIdParamsSchema, body: s.savedCreatePlaceSchema },
    responses: { ...common, 200: json(s.savedPlaceCreatedSchema) },
  },
  exportSavedList: {
    method: "GET",
    path: "/api/saved/lists/:id/export",
    auth: "session",
    request: { params: s.savedIdParamsSchema, query: s.savedExportQuerySchema },
    responses: {
      ...common,
      200: {
        kind: "text-download",
        mediaTypes: Object.values(EXPORT_CONTENT_TYPE),
        mediaTypeQuery: {
          name: "format",
          default: s.savedExportQuerySchema.parse({}).format,
          values: EXPORT_CONTENT_TYPE,
        },
        headers: z.object({ "content-disposition": z.string().startsWith("attachment;") }),
      },
    },
  },
  updateSavedPlace: {
    method: "PATCH",
    path: "/api/saved/places/:id",
    auth: "session",
    request: { params: s.savedIdParamsSchema, body: s.savedUpdatePlaceSchema },
    responses: ok,
  },
  deleteSavedPlace: {
    method: "DELETE",
    path: "/api/saved/places/:id",
    auth: "session",
    request: { params: s.savedIdParamsSchema },
    responses: ok,
  },
  listSavedLabels: {
    method: "GET",
    path: "/api/saved/labels",
    auth: "session",
    responses: { ...common, 200: json(s.savedLabelsResponseSchema) },
  },
  writeSavedLabel: {
    method: "PUT",
    path: "/api/saved/labels/:label",
    auth: "session",
    request: { params: s.savedLabelParamsSchema, body: s.savedWriteLabelSchema },
    responses: { ...common, 200: json(s.savedLabelWrittenSchema) },
  },
  deleteSavedLabel: {
    method: "DELETE",
    path: "/api/saved/labels/:label",
    auth: "session",
    request: { params: s.savedLabelParamsSchema },
    responses: ok,
  },
  checkSavedPlace: {
    method: "GET",
    path: "/api/saved/check",
    auth: "session",
    request: { query: s.savedCheckQuerySchema },
    responses: { ...common, 200: json(s.savedCheckResponseSchema) },
  },
} as const satisfies Record<string, ApiOperation>;
