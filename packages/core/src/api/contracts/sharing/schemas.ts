import z from "zod/v4";
import { BIKE_HILL_PREFERENCES, BIKE_PROFILES } from "../../../routing/bicycleOptions";
import {
  savedCreateListSchema,
  savedCreatePlaceSchema,
  savedUpdatePlaceSchema,
} from "../saved/schemas";

export const SHARE_TOKEN_PATTERN = "^[A-Za-z0-9_-]{20,64}$";
export const MAX_SHARES_PER_USER = 100;
export const MAX_SNAPSHOT_PLACES = 1000;
export const MAX_EXPIRES_IN_DAYS = 365;
export const MAX_SHARE_WAYPOINTS = 10;
export const MAX_SHARE_LABEL_LENGTH = 200;
/** 1000 places can each retain 64KiB of captured attribution plus bounded text. */
export const MAX_PUBLIC_SHARE_JSON_BYTES = 128 * 1024 * 1024;
const id = z.string().min(1).max(100);
const token = z.string().regex(new RegExp(SHARE_TOKEN_PATTERN));
const timestamp = z.iso.datetime({ offset: true });
export const sharingWaypointSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().max(MAX_SHARE_LABEL_LENGTH).optional(),
});
export const sharingScheduleSchema = z.strictObject({
  departAfter: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
  arriveBy: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
  fixedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
  dwellSeconds: z.number().int().min(0).max(86400).optional(),
  timeZone: z.string().max(256).optional(),
});
export const sharingRouteSchema = z
  .strictObject({
    waypoints: z.array(sharingWaypointSchema).min(2).max(MAX_SHARE_WAYPOINTS),
    mode: z.enum(["driving", "walking", "cycling", "motorcycle"]),
    avoidHighways: z.boolean().optional(),
    avoidTolls: z.boolean().optional(),
    avoidFerries: z.boolean().optional(),
    bikeProfile: z.enum(BIKE_PROFILES).optional(),
    bikeHillPreference: z.enum(BIKE_HILL_PREFERENCES).optional(),
    bikePreferQuietRoads: z.boolean().optional(),
    bikePreferSmoothSurfaces: z.boolean().optional(),
    bikeSpeedKmh: z.number().min(5).max(60).optional(),
    scheduleVersion: z.literal(1).optional(),
    schedules: z.array(sharingScheduleSchema.nullable()).min(2).max(MAX_SHARE_WAYPOINTS).optional(),
  })
  .refine(
    (value) => value.schedules === undefined || value.schedules.length === value.waypoints.length,
    "Schedules must align with waypoints",
  );
export const sharingPlaceSchema = z.strictObject({
  ...savedCreatePlaceSchema.shape,
  name: savedUpdatePlaceSchema.shape.name.unwrap(),
});
export const sharingListSnapshotSchema = z.strictObject({
  name: savedCreateListSchema.shape.name,
  icon: savedCreateListSchema.shape.icon.unwrap().nullable(),
  places: z.array(sharingPlaceSchema).max(MAX_SNAPSHOT_PLACES),
});
export const sharingPublicListSchema = sharingListSnapshotSchema.extend({
  type: z.literal("list"),
  mode: z.enum(["live", "snapshot"]),
});
export const sharingPublicRouteSchema = z.strictObject({
  type: z.literal("route"),
  mode: z.literal("snapshot"),
  route: sharingRouteSchema,
});
export const sharingPublicSchema = z.discriminatedUnion("type", [
  sharingPublicListSchema,
  sharingPublicRouteSchema,
]);
export const sharingOwnerSchema = z.strictObject({
  id,
  targetType: z.enum(["list", "route"]),
  targetId: id.nullable(),
  mode: z.enum(["live", "snapshot"]),
  label: z.string().max(500),
  createdAt: timestamp,
  updatedAt: timestamp,
  expiresAt: timestamp.nullable(),
});
const expiry = z.number().int().min(1).max(MAX_EXPIRES_IN_DAYS).optional();
export const sharingCreateSchema = z.discriminatedUnion("targetType", [
  z.strictObject({
    targetType: z.literal("list"),
    targetId: id,
    mode: z.enum(["live", "snapshot"]),
    expiresInDays: expiry,
  }),
  z.strictObject({
    targetType: z.literal("route"),
    route: sharingRouteSchema,
    expiresInDays: expiry,
  }),
]);
export const sharingCreatedSchema = z.strictObject({ id, token, share: sharingOwnerSchema });
export const sharingRotatedSchema = z.strictObject({ token });
export const sharingListSchema = z.strictObject({
  shares: z.array(sharingOwnerSchema).max(MAX_SHARES_PER_USER),
});
export const sharingOkSchema = z.strictObject({ ok: z.literal(true) });
export const sharingIdParamsSchema = z.strictObject({ id });
export const sharingTokenParamsSchema = z.strictObject({ token });
export const sharingPublicHeadersSchema = z.object({ "cache-control": z.literal("no-store") });
export const sharingOwnerHeadersSchema = z.object({
  "cache-control": z.literal("private, no-store"),
  pragma: z.literal("no-cache"),
  vary: z.string().regex(/(?:^|,\s*)Cookie(?:\s*,|$)/i),
});
export type OwnerShare = z.infer<typeof sharingOwnerSchema>;
export type RouteShareWaypoint = z.infer<typeof sharingWaypointSchema>;
export type ShareWaypointSchedule = z.infer<typeof sharingScheduleSchema>;
export type RouteSharePayload = z.infer<typeof sharingRouteSchema>;
export type StoredListSnapshot = z.infer<typeof sharingListSnapshotSchema>;
export type PublicSharePlace = z.infer<typeof sharingPlaceSchema>;
export type PublicListShare = z.infer<typeof sharingPublicListSchema>;
export type PublicRouteShare = z.infer<typeof sharingPublicRouteSchema>;
export type PublicShare = z.infer<typeof sharingPublicSchema>;
export type CreateShareInput = z.infer<typeof sharingCreateSchema>;
