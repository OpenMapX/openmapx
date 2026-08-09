import { z } from "zod";

const finiteNumber = z.number().finite();
const longitude = finiteNumber.min(-180).max(180);
const latitude = finiteNumber.min(-90).max(90);
const timestamp = z.iso.datetime({ offset: true });
const identifier = z.union([z.string().min(1), z.number().int().nonnegative()]);

const locationSchema = z.object({
  lat: latitude,
  lng: longitude,
});

export const currentUserSchema = z.object({
  user: z.object({
    email: z.string().email(),
    settings: z.object({ timezone: z.string().min(1) }),
  }),
});

export const settingsSchema = z.object({
  settings: z.object({
    timezone: z.string().min(1),
    maps: z.object({ distance_unit: z.string().min(1) }).optional(),
  }),
  status: z.string(),
});

export const timelineSummarySchema = z.object({
  total_distance: finiteNumber,
  distance_unit: z.string().min(1),
  places_visited: z.number().int().nonnegative(),
  time_moving_minutes: finiteNumber.nonnegative(),
  time_stationary_minutes: finiteNumber.nonnegative(),
});

export const timelineBoundsSchema = z
  .object({
    sw_lng: longitude,
    sw_lat: latitude,
    ne_lng: longitude,
    ne_lat: latitude,
  })
  .refine((bounds) => bounds.sw_lng <= bounds.ne_lng && bounds.sw_lat <= bounds.ne_lat, {
    message: "bounds must be southwest to northeast",
  });

export const timelineVisitSchema = z.object({
  type: z.literal("visit"),
  visit_id: identifier,
  name: z.string().nullable(),
  status: z.string().nullable(),
  place_id: identifier.nullable().optional(),
  point_count: z.number().int().nonnegative().nullable().optional(),
  tags: z.array(z.object({ name: z.string() }).passthrough()),
  started_at: timestamp,
  ended_at: timestamp,
  duration: finiteNumber.nonnegative(),
  place: locationSchema.nullable(),
});

export const timelineJourneySchema = z.object({
  type: z.literal("journey"),
  track_id: identifier,
  started_at: timestamp,
  ended_at: timestamp,
  duration: finiteNumber.nonnegative(),
  distance: finiteNumber.nullable().optional(),
  distance_unit: z.string().min(1),
  dominant_mode: z.string().nullable(),
  avg_speed: finiteNumber.nullable().optional(),
  speed_unit: z.string().nullable().optional(),
  elevation_gain: finiteNumber.nullable().optional(),
  elevation_loss: finiteNumber.nullable().optional(),
  continuation_of_date: z.iso.date().nullable().optional(),
  day_distance: finiteNumber.nullable().optional(),
  day_duration: finiteNumber.nonnegative().nullable().optional(),
});

export const timelineEntrySchema = z.discriminatedUnion("type", [
  timelineVisitSchema,
  timelineJourneySchema,
]);

export const timelineDaySchema = z.object({
  date: z.iso.date(),
  summary: timelineSummarySchema,
  bounds: timelineBoundsSchema.nullable(),
  entries: z.array(timelineEntrySchema),
});

export const timelineResponseSchema = z.object({ days: z.array(timelineDaySchema) });

const position = z.tuple([longitude, latitude]).rest(finiteNumber);

export const trackLineStringSchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(position).min(2),
});

export const trackFeatureSchema = z.object({
  type: z.literal("Feature"),
  geometry: trackLineStringSchema,
  properties: z.record(z.string(), z.unknown()),
});

export const tracksFeatureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(trackFeatureSchema),
});

export type DawarichCurrentUser = z.infer<typeof currentUserSchema>;
export type DawarichSettings = z.infer<typeof settingsSchema>;
export type DawarichTimelineResponse = z.infer<typeof timelineResponseSchema>;
export type DawarichTimelineDay = z.infer<typeof timelineDaySchema>;
export type DawarichTrackFeatureCollection = z.infer<typeof tracksFeatureCollectionSchema>;
