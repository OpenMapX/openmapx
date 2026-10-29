import z from "zod/v4";
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
const ok = { ...common, 200: json(s.garageOkSchema, s.garageNoStoreHeadersSchema) };
export const garageOperations = {
  listGarageVehicles: {
    method: "GET",
    path: "/api/vehicles",
    auth: "session",
    responses: { ...common, 200: json(s.garageVehiclesSchema, s.garageNoStoreHeadersSchema) },
  },
  createGarageVehicle: {
    method: "POST",
    path: "/api/vehicles",
    auth: "session",
    request: { body: s.garageCreateVehicleSchema },
    responses: { ...common, 200: json(s.garageVehicleCreatedSchema, s.garageNoStoreHeadersSchema) },
  },
  updateGarageVehicle: {
    method: "PATCH",
    path: "/api/vehicles/:id",
    auth: "session",
    request: { params: s.garageIdParamsSchema, body: s.garageUpdateVehicleSchema },
    responses: ok,
  },
  deleteGarageVehicle: {
    method: "DELETE",
    path: "/api/vehicles/:id",
    auth: "session",
    request: { params: s.garageIdParamsSchema },
    responses: ok,
  },
  listGarageParking: {
    method: "GET",
    path: "/api/parking",
    auth: "session",
    responses: { ...common, 200: json(s.garageParkingSchema, s.garageNoStoreHeadersSchema) },
  },
  saveGarageParking: {
    method: "PUT",
    path: "/api/parking",
    auth: "session",
    request: { body: s.garageSaveParkedSchema },
    responses: { ...common, 200: json(s.garageParkedSchema, s.garageNoStoreHeadersSchema) },
  },
  updateGarageParking: {
    method: "PATCH",
    path: "/api/parking/:id",
    auth: "session",
    request: { params: s.garageIdParamsSchema, body: s.garageUpdateParkedSchema },
    responses: ok,
  },
  deleteGarageParking: {
    method: "DELETE",
    path: "/api/parking/:id",
    auth: "session",
    request: { params: s.garageIdParamsSchema },
    responses: ok,
  },
} as const satisfies Record<string, ApiOperation>;
