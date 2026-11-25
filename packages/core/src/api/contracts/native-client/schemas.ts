import z from "zod/v4";
import {
  lngLatSchema,
  MOBILE_PROTOCOL_UNSUPPORTED,
  navigationRouteSchema,
} from "../../../navigation/mobileProtocol";
import { BIKE_HILL_PREFERENCES, BIKE_PROFILES } from "../../../routing/bicycleOptions";

/*
 * What an installed app sends to, and reads from, the API routes it calls
 * without a WebView. Requests name exactly what the app sends. Responses name
 * the fields the app reads and let every other field through, so the server
 * may add fields freely but must keep these.
 */

const booleanQuery = z.enum(["true", "false"]);
const decimalQuery = z.string().regex(/^-?\d+(\.\d+)?$/);
const groundModeQuery = z.enum(["driving", "walking", "cycling", "motorcycle"]);
const localeQuery = z.string().min(2).max(16);

export const nativeGeocodeQuerySchema = z.strictObject({
  q: z.string().min(1).max(160),
  lang: localeQuery.optional(),
  lat: decimalQuery.optional(),
  lng: decimalQuery.optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

export const nativeGeocodeResponseSchema = z
  .array(
    z.looseObject({
      id: z.string().optional(),
      label: z.string(),
      coordinates: z.tuple([z.number(), z.number()]),
    }),
  )
  .max(100);

export const nativeDirectionsQuerySchema = z.strictObject({
  /** At least two `lng,lat` pairs joined by `;`, each number as JavaScript prints it. */
  waypoints: z.string().min(7),
  mode: groundModeQuery,
  bikeProfile: z.enum(BIKE_PROFILES).optional(),
  bikeHillPreference: z.enum(BIKE_HILL_PREFERENCES).optional(),
  bikePreferQuietRoads: booleanQuery.optional(),
  bikePreferSmoothSurfaces: booleanQuery.optional(),
  bikeSpeedKmh: decimalQuery.optional(),
  avoidHighways: booleanQuery,
  avoidTolls: booleanQuery,
  avoidFerries: booleanQuery,
  avoidClosures: z.literal("1").optional(),
  units: z.enum(["metric", "imperial"]),
  lang: localeQuery.optional(),
});

export const nativeDirectionsResponseSchema = z.looseObject({
  routes: z.array(navigationRouteSchema),
  activeRouteIndex: z.number().int().nonnegative().optional(),
});

export const nativeRouteMatchBodySchema = z.strictObject({
  trace: z
    .array(z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }))
    .min(2)
    .max(10_000),
  mode: groundModeQuery,
  shapeMatch: z.literal("map_snap"),
});

export const nativeRouteMatchResponseSchema = z.looseObject({
  geometry: z.array(lngLatSchema),
  edges: z.array(
    z.looseObject({
      wayId: z.number().int().optional(),
      endShapeIndex: z.number().int().nonnegative(),
      speedLimit: z.number().optional(),
      endNodeTrafficSignal: z.boolean().optional(),
      endNodeCountryCode: z.string().optional(),
    }),
  ),
  points: z.array(z.looseObject({ edgeIndex: z.number().int().nonnegative().optional() })),
});

export const nativeNavigationLandmarksBodySchema = z.strictObject({
  points: z
    .array(z.strictObject({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }))
    .min(1)
    .max(40),
});

export const nativeNavigationLandmarksResponseSchema = z.looseObject({
  results: z.array(
    z.looseObject({
      candidates: z.array(
        z.looseObject({
          category: z.enum(["fuel", "place_of_worship", "pharmacy", "supermarket", "fast_food"]),
          brand: z.string().optional(),
          religion: z.string().optional(),
          lat: z.number(),
          lon: z.number(),
          outline: z.array(z.tuple([z.number(), z.number()])).optional(),
        }),
      ),
      unavailable: z.literal(true).optional(),
    }),
  ),
});

export const nativeTransitPlanRefreshBodySchema = z.strictObject({
  token: z.string().min(1).max(4_096),
});

export const nativeTransitPlanRefreshResponseSchema = z.looseObject({
  data: z.looseObject({
    itinerary: z.looseObject({
      legs: z.array(z.looseObject({})),
      refreshToken: z.string().optional(),
    }),
    fallbackOccurred: z.boolean(),
  }),
});

export const nativeVehicleJourneyParamsSchema = z.strictObject({
  id: z.string().min(1),
});

const platformEvidenceSchema = z.looseObject({
  code: z.string(),
  scheduledCode: z.string().optional(),
  kind: z.enum(["schedule", "correction", "realtime"]),
  sourceId: z.string(),
  recordedAt: z.string().optional(),
  fetchedAt: z.string().optional(),
});

export const nativeVehicleJourneyResponseSchema = z.looseObject({
  data: z.looseObject({
    stops: z.array(
      z.looseObject({
        stopId: z.string(),
        name: z.string().optional(),
        lat: z.number().optional(),
        lng: z.number().optional(),
        platform: z.string().optional(),
        scheduledPlatform: z.string().optional(),
        arrivalPlatform: platformEvidenceSchema.optional(),
        departurePlatform: platformEvidenceSchema.optional(),
        scheduledArrival: z.string().optional(),
        scheduledDeparture: z.string().optional(),
        expectedArrival: z.string().optional(),
        expectedDeparture: z.string().optional(),
        canceled: z.boolean().optional(),
        departed: z.boolean().optional(),
      }),
    ),
  }),
});

/** The API no longer serves the protocol the app named; only a store update helps. */
export const mobileProtocolUnsupportedSchema = z.strictObject({
  error: z.string(),
  code: z.literal(MOBILE_PROTOCOL_UNSUPPORTED),
});

/** Integration routes answer a refusal with a plain message. */
export const nativeErrorSchema = z.looseObject({ error: z.string() });
