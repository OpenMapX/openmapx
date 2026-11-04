import { z } from "zod";
import {
  enforceAggregateBounds,
  lngLatSchema,
  MAX_MESSAGE_BYTES,
  MAX_TOTAL_COORDINATES,
  nativeToWebSchema,
  type ParseResult,
  parseMobileBridgeMessage,
} from "./mobileProtocol";

const distance = z.number().finite().min(0).max(32768);
const insets = z
  .object({ top: distance, right: distance, bottom: distance, left: distance })
  .strict();
const base = { v: z.literal(1) };
const scalar = z.number().finite().min(-100000).max(100000);
export const carCameraSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...base,
      type: z.literal("car-camera"),
      action: z.literal("pan"),
      dx: scalar,
      dy: scalar,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("car-camera"),
      action: z.literal("zoom"),
      factor: z.number().finite().positive().max(100),
      x: distance.optional(),
      y: distance.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("car-camera"),
      action: z.literal("fling"),
      vx: scalar,
      vy: scalar,
    })
    .strict(),
  z.object({ ...base, type: z.literal("car-camera"), action: z.literal("recenter") }).strict(),
]);
export const carViewportSchema = z
  .object({
    ...base,
    type: z.literal("car-viewport"),
    width: distance.positive(),
    height: distance.positive(),
    stable: insets,
    visible: insets,
    dark: z.boolean(),
  })
  .strict()
  .refine((v) =>
    [v.stable, v.visible].every((i) => i.left + i.right < v.width && i.top + i.bottom < v.height),
  );
export const carPreviewSchema = z
  .union([
    z.object({ ...base, type: z.literal("car-preview"), routes: z.tuple([]) }).strict(),
    z
      .object({
        ...base,
        type: z.literal("car-preview"),
        routes: z
          .array(
            z
              .object({
                coordinates: z.array(lngLatSchema).min(2).max(MAX_TOTAL_COORDINATES),
              })
              .strict(),
          )
          .min(1)
          .max(9),
        selected: z.number().int().nonnegative(),
      })
      .strict()
      .refine((v) => v.selected < v.routes.length),
  ])
  .refine((v) => v.routes.reduce((n, r) => n + r.coordinates.length, 0) <= MAX_TOTAL_COORDINATES);
export const carNativeToWebSchema = z.union([
  z
    .object({
      ...base,
      type: z.literal("car-hello"),
      locale: z.enum(["en", "de"]),
      units: z.enum(["metric", "imperial"]),
      dark: z.boolean(),
    })
    .strict(),
  carViewportSchema,
  z
    .object({
      ...base,
      type: z.literal("car-snapshot"),
      message: nativeToWebSchema.refine(
        (m) => m.type === "snapshot.update" || m.type === "session.stopped",
      ),
    })
    .strict(),
  carPreviewSchema,
  carCameraSchema,
]);
export const carWebToNativeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("car-ready") }).strict(),
  z.object({ ...base, type: z.literal("car-map-state"), following: z.boolean() }).strict(),
  z
    .object({
      ...base,
      type: z.literal("car-error"),
      code: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9-]+$/),
    })
    .strict(),
]);
export const carSurfaceMessageSchema = z.union([carNativeToWebSchema, carWebToNativeSchema]);
export type CarNativeToWebMessage = z.infer<typeof carNativeToWebSchema>;
export type CarWebToNativeMessage = z.infer<typeof carWebToNativeSchema>;
export type CarSurfaceMessage = z.infer<typeof carSurfaceMessageSchema>;
export type CarViewport = z.infer<typeof carViewportSchema>;
export type CarCamera = z.infer<typeof carCameraSchema>;
export type CarPreview = z.infer<typeof carPreviewSchema>;

export function parseCarSurfaceMessage(raw: string): ParseResult<CarSurfaceMessage> {
  if (typeof raw !== "string") return { ok: false, error: { code: "invalid-message" } };
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES)
    return { ok: false, error: { code: "payload-too-large" } };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "invalid-json" } };
  }
  const parsed = carSurfaceMessageSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: { code: "invalid-message" } };
  if (parsed.data.type === "car-snapshot") {
    const nested = parseMobileBridgeMessage(JSON.stringify(parsed.data.message));
    if (!nested.ok) return nested;
  }
  return enforceAggregateBounds(parsed.data);
}
