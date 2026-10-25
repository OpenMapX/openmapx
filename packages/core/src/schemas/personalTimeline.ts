import z from "zod/v4";

export const personalTimelineWarningSchema = z.enum([
  "TRACK_GEOMETRY_UNAVAILABLE",
  "PARTIAL_TRACK_PAGE_LIMIT",
]);
export const personalTimelineErrorCodeSchema = z.enum([
  "TIMELINE_NOT_CONNECTED",
  "TIMELINE_MANAGED_DISABLED",
  "TIMELINE_CREDENTIAL_INVALID",
  "TIMELINE_INSTANCE_UNSUPPORTED",
  "TIMELINE_PLAN_RESTRICTED",
  "TIMELINE_RATE_LIMITED",
  "TIMELINE_UPSTREAM_UNAVAILABLE",
  "TIMELINE_RESPONSE_INVALID",
]);
export const timelineConnectionModeSchema = z.enum(["external", "managed"]);
export const timelineConnectionStatusSchema = z.enum(["connected", "degraded", "invalid"]);

const finite = z.number().finite();
const longitude = finite.min(-180).max(180);
const latitude = finite.min(-90).max(90);
const timestamp = z.iso.datetime({ offset: true });
const publicOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}, "Expected a public HTTPS origin");

// Objects intentionally project declared fields, including nested map properties,
// so additive upstream/internal data never enters timeline query or UI state.
export const timelineConnectionViewSchema = z
  .object({
    connected: z.boolean(),
    connection: z
      .object({
        mode: timelineConnectionModeSchema,
        publicOrigin,
        displayName: z.string(),
        upstreamEmail: z.string().nullable(),
        timeZone: z.string().min(1),
        distanceUnit: z.string().nullable(),
        status: timelineConnectionStatusSchema,
        validatedAt: timestamp,
        lastReadAt: timestamp.nullable(),
      })
      .nullable(),
    managed: z.object({
      available: z.boolean(),
      healthy: z.boolean(),
      publicOrigin: publicOrigin.nullable(),
      reason: z.enum(["disabled", "unhealthy", "unprovisioned"]).nullable(),
    }),
  })
  .refine((value) => value.connected === (value.connection !== null), "Inconsistent connection");

export const personalTimelineDisconnectSchema = z.object({ ok: z.literal(true) });
export const personalTimelineSummaryV1Schema = z.object({
  totalDistance: finite,
  placesVisited: finite.int().nonnegative(),
  movingMinutes: finite.nonnegative(),
  stationaryMinutes: finite.nonnegative(),
});
export const personalTimelineVisitV1Schema = z.object({
  type: z.literal("visit"),
  id: z.string().min(1),
  name: z.string().nullable(),
  status: z.string().nullable(),
  startedAt: timestamp,
  endedAt: timestamp,
  durationMinutes: finite.nonnegative(),
  pointCount: finite.int().nonnegative().optional(),
  placeId: z.string().min(1).optional(),
  tags: z.array(z.string()),
  location: z.object({ longitude, latitude }).nullable(),
});
export const personalTimelineJourneyV1Schema = z.object({
  type: z.literal("journey"),
  id: z.string().min(1),
  startedAt: timestamp,
  endedAt: timestamp,
  durationSeconds: finite.nonnegative(),
  distance: finite.optional(),
  distanceUnit: z.string().min(1),
  dominantMode: z.string().nullable(),
  averageSpeed: finite.optional(),
  speedUnit: z.string().optional(),
  elevationGain: finite.optional(),
  elevationLoss: finite.optional(),
  continuationOfDate: z.iso.date().optional(),
  dayDistance: finite.optional(),
  dayDurationSeconds: finite.nonnegative().optional(),
});

// GeoJSON permits additional finite coordinate dimensions (e.g. elevation).
// Keep number[] compatible with the producer's GeoJSON.Position declarations.
const position = z
  .array(finite)
  .min(2)
  .refine(
    (value) => value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90,
    "Invalid longitude/latitude",
  );
const featureCollection = <T extends z.ZodType>(geometry: T) =>
  z.object({
    type: z.literal("FeatureCollection"),
    features: z.array(
      z.object({
        type: z.literal("Feature"),
        geometry,
        properties: z.object({ id: z.string().min(1) }),
      }),
    ),
  });

export const personalTimelineDayV1Schema = z.object({
  version: z.literal(1),
  date: z.iso.date(),
  timeZone: z.string().min(1),
  distanceUnit: z.string().min(1),
  summary: personalTimelineSummaryV1Schema,
  bounds: z
    .tuple([longitude, latitude, longitude, latitude])
    .refine((value) => value[0] <= value[2] && value[1] <= value[3], "Invalid bounds")
    .nullable(),
  entries: z.array(
    z.discriminatedUnion("type", [personalTimelineVisitV1Schema, personalTimelineJourneyV1Schema]),
  ),
  map: z.object({
    tracks: featureCollection(
      z.object({ type: z.literal("LineString"), coordinates: z.array(position).min(2) }),
    ),
    visits: featureCollection(z.object({ type: z.literal("Point"), coordinates: position })),
  }),
  capabilities: z.object({ trackGeometry: z.boolean(), elevation: z.boolean() }),
  warnings: z.array(personalTimelineWarningSchema),
});

export type PersonalTimelineWarning = z.infer<typeof personalTimelineWarningSchema>;
export type PersonalTimelineErrorCode = z.infer<typeof personalTimelineErrorCodeSchema>;
export type TimelineConnectionMode = z.infer<typeof timelineConnectionModeSchema>;
export type TimelineConnectionStatus = z.infer<typeof timelineConnectionStatusSchema>;
export type TimelineConnectionView = z.infer<typeof timelineConnectionViewSchema>;
export type PersonalTimelineSummaryV1 = z.infer<typeof personalTimelineSummaryV1Schema>;
export type PersonalTimelineVisitV1 = z.infer<typeof personalTimelineVisitV1Schema>;
export type PersonalTimelineJourneyV1 = z.infer<typeof personalTimelineJourneyV1Schema>;
export type PersonalTimelineDayV1 = z.infer<typeof personalTimelineDayV1Schema>;
