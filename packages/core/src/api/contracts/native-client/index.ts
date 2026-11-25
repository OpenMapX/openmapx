import { json } from "../../../services/data-manager/contracts/common";
import type { ApiOperation } from "../operation";
import * as s from "./schemas";

export {
  isSupportedMobileProtocol,
  MOBILE_PROTOCOL_HEADER,
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  MOBILE_PROTOCOL_UNSUPPORTED,
} from "../../../navigation/mobileProtocol";
export * from "./schemas";

const errors = {
  400: json(s.nativeErrorSchema),
  426: json(s.mobileProtocolUnsupportedSchema),
  429: json(s.nativeErrorSchema),
  500: json(s.nativeErrorSchema),
  502: json(s.nativeErrorSchema),
  503: json(s.nativeErrorSchema),
};

/**
 * The API operations an installed app calls without a WebView: from CarPlay
 * and Android Auto, and from the headless navigation task. A store binary keeps
 * calling them for as long as it stays installed, so they are versioned by
 * `MOBILE_PROTOCOL_MAX` and every request names that version in
 * `MOBILE_PROTOCOL_HEADER`. A schema change here raises the protocol: the
 * digest committed beside the protocol constants must match this family.
 */
export const nativeClientOperations = {
  geocode: {
    method: "GET",
    path: "/api/integrations/geocoding/geocode",
    auth: "public",
    request: { query: s.nativeGeocodeQuerySchema },
    responses: { ...errors, 200: json(s.nativeGeocodeResponseSchema) },
  },
  directions: {
    method: "GET",
    path: "/api/integrations/routing/directions",
    auth: "public",
    request: { query: s.nativeDirectionsQuerySchema },
    responses: {
      ...errors,
      404: json(s.nativeErrorSchema),
      200: json(s.nativeDirectionsResponseSchema),
    },
  },
  matchRoute: {
    method: "POST",
    path: "/api/integrations/routing/match",
    auth: "public",
    request: { body: s.nativeRouteMatchBodySchema },
    responses: { ...errors, 200: json(s.nativeRouteMatchResponseSchema) },
  },
  navigationLandmarks: {
    method: "POST",
    path: "/api/integrations/routing/navigation/landmarks",
    auth: "public",
    request: { body: s.nativeNavigationLandmarksBodySchema },
    responses: { ...errors, 200: json(s.nativeNavigationLandmarksResponseSchema) },
  },
  refreshTransitPlan: {
    method: "POST",
    path: "/api/integrations/transit/plan/refresh",
    auth: "public",
    request: { body: s.nativeTransitPlanRefreshBodySchema },
    responses: {
      ...errors,
      409: json(s.nativeErrorSchema),
      200: json(s.nativeTransitPlanRefreshResponseSchema),
    },
  },
  vehicleJourney: {
    method: "GET",
    path: "/api/integrations/transit/vehicles/:id",
    auth: "public",
    request: { params: s.nativeVehicleJourneyParamsSchema },
    responses: {
      ...errors,
      404: json(s.nativeErrorSchema),
      200: json(s.nativeVehicleJourneyResponseSchema),
    },
  },
} as const satisfies Record<string, ApiOperation>;
