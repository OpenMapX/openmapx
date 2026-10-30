import z from "zod/v4";
import { httpErrorSchema, json } from "../../../services/data-manager/contracts/common";
import { authenticationRetryAfterHeadersSchema } from "../../../services/data-manager/contracts/headers";
import type { ApiOperation } from "../operation";
import * as s from "./schemas";

export * from "./schemas";

const errors = {
  400: json(httpErrorSchema),
  401: json(httpErrorSchema),
  403: json(httpErrorSchema),
  404: json(httpErrorSchema),
  409: json(httpErrorSchema),
  413: json(httpErrorSchema),
  415: json(httpErrorSchema),
  500: json(httpErrorSchema),
  429: json(
    z.union([
      httpErrorSchema,
      z.strictObject({ error: z.string(), retryAfter: z.number().int().nonnegative() }),
    ]),
    authenticationRetryAfterHeadersSchema,
  ),
};
export const sharingOperations = {
  resolvePublicShare: {
    method: "GET",
    path: "/api/shares/:token",
    auth: "public",
    request: { params: s.sharingTokenParamsSchema },
    responses: { ...errors, 200: json(s.sharingPublicSchema, s.sharingPublicHeadersSchema) },
  },
  listOwnerShares: {
    method: "GET",
    path: "/api/shares",
    auth: "session",
    responses: { ...errors, 200: json(s.sharingListSchema, s.sharingOwnerHeadersSchema) },
  },
  createShare: {
    method: "POST",
    path: "/api/shares",
    auth: "session",
    request: { body: s.sharingCreateSchema },
    responses: { ...errors, 201: json(s.sharingCreatedSchema, s.sharingOwnerHeadersSchema) },
  },
  rotateShareToken: {
    method: "POST",
    path: "/api/shares/:id/rotate",
    auth: "session",
    request: { params: s.sharingIdParamsSchema },
    responses: { ...errors, 200: json(s.sharingRotatedSchema, s.sharingOwnerHeadersSchema) },
  },
  revokeShare: {
    method: "DELETE",
    path: "/api/shares/:id",
    auth: "session",
    request: { params: s.sharingIdParamsSchema },
    responses: { ...errors, 200: json(s.sharingOkSchema, s.sharingOwnerHeadersSchema) },
  },
} as const satisfies Record<string, ApiOperation>;
