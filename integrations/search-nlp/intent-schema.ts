import type { SearchIntent } from "@openmapx/core";
import { z } from "zod/v4";

const spatialConstraint = z.discriminatedUnion("type", [
  z.object({ type: z.literal("near_place"), place_name: z.string().min(1) }).strict(),
  z.object({ type: z.literal("near_coordinates"), lat: z.number(), lng: z.number() }).strict(),
  z
    .object({
      type: z.literal("within_bbox"),
      south: z.number(),
      west: z.number(),
      north: z.number(),
      east: z.number(),
    })
    .strict(),
  z.object({ type: z.literal("current_view") }).strict(),
]);

const timeConstraint = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open_now") }).strict(),
  z
    .object({ type: z.literal("open_at"), day: z.string().min(1), time: z.string().min(1) })
    .strict(),
  z.object({ type: z.literal("open_24h") }).strict(),
]);

const tagPredicate = z
  .object({
    key: z.string().min(1),
    op: z.enum(["=", "~", "exists"]).optional(),
    value: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((predicate, ctx) => {
    if (predicate.op !== "exists" && predicate.value === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "value is required unless op is exists",
      });
    }
  });

const filterSchema = z
  .object({
    selectors: z.array(z.object({ tags: z.array(tagPredicate) }).strict()),
    require: z.array(tagPredicate).optional(),
    exclude: z.array(tagPredicate).optional(),
    elementTypes: z.array(z.enum(["node", "way", "relation"])).optional(),
  })
  .strict();

/** The application/domain shape consumed after model output normalization. */
export const SearchIntentSchema = z
  .object({
    filter: filterSchema,
    spatial_constraint: spatialConstraint.nullable(),
    time_constraint: timeConstraint.nullable(),
    sort_by: z.enum(["relevance", "distance", "rating"]),
    unmapped_attributes: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    explanation: z.string(),
  })
  .strict();

export type SearchIntentParsed = z.infer<typeof SearchIntentSchema>;

/*
 * Provider-portable wire schema.
 *
 * OpenAI strict JSON Schema requires every property to be required, while
 * Gemini's native structured output supports only a subset of OpenAPI and does
 * not support unions. The model therefore emits a deliberately flat shape with
 * nullable variant fields and empty arrays. normalizeSearchIntent then converts
 * it to the stricter discriminated domain shape above.
 */
const wirePredicateSchema = z
  .object({
    key: z.string().describe("OpenStreetMap tag key"),
    op: z.enum(["=", "~", "exists"]).nullable(),
    value: z.string().nullable(),
  })
  .strict();

const wireSpatialSchema = z
  .object({
    type: z.enum(["near_place", "near_coordinates", "within_bbox", "current_view"]),
    place_name: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    south: z.number().nullable(),
    west: z.number().nullable(),
    north: z.number().nullable(),
    east: z.number().nullable(),
  })
  .strict();

const wireTimeSchema = z
  .object({
    type: z.enum(["open_now", "open_at", "open_24h"]),
    day: z.string().nullable(),
    time: z.string().nullable(),
  })
  .strict();

export const SearchIntentWireSchema = z
  .object({
    filter: z
      .object({
        selectors: z.array(z.object({ tags: z.array(wirePredicateSchema) }).strict()),
        require: z.array(wirePredicateSchema),
        exclude: z.array(wirePredicateSchema),
        elementTypes: z.array(z.enum(["node", "way", "relation"])),
      })
      .strict(),
    spatial_constraint: wireSpatialSchema.nullable(),
    time_constraint: wireTimeSchema.nullable(),
    sort_by: z.enum(["relevance", "distance", "rating"]),
    unmapped_attributes: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    explanation: z.string(),
  })
  .strict();

export type SearchIntentWire = z.infer<typeof SearchIntentWireSchema>;

function required<T>(value: T | null, path: string): T {
  if (value === null) throw new Error(`${path} is required for the selected type`);
  return value;
}

function normalizePredicate(predicate: z.infer<typeof wirePredicateSchema>): {
  key: string;
  op?: "=" | "~" | "exists";
  value?: string;
} {
  if (predicate.op === "exists") return { key: predicate.key, op: "exists" };
  const value = required(predicate.value, `filter predicate ${predicate.key}.value`);
  return {
    key: predicate.key,
    ...(predicate.op === null ? {} : { op: predicate.op }),
    value,
  };
}

function normalizeSpatial(value: SearchIntentWire["spatial_constraint"]) {
  if (value === null) return null;
  switch (value.type) {
    case "near_place":
      return { type: value.type, place_name: required(value.place_name, "place_name") } as const;
    case "near_coordinates":
      return {
        type: value.type,
        lat: required(value.lat, "lat"),
        lng: required(value.lng, "lng"),
      } as const;
    case "within_bbox":
      return {
        type: value.type,
        south: required(value.south, "south"),
        west: required(value.west, "west"),
        north: required(value.north, "north"),
        east: required(value.east, "east"),
      } as const;
    case "current_view":
      return { type: value.type } as const;
  }
}

function normalizeTime(value: SearchIntentWire["time_constraint"]) {
  if (value === null) return null;
  switch (value.type) {
    case "open_at":
      return {
        type: value.type,
        day: required(value.day, "day"),
        time: required(value.time, "time"),
      } as const;
    case "open_now":
    case "open_24h":
      return { type: value.type } as const;
  }
}

export function normalizeSearchIntent(wire: SearchIntentWire): SearchIntent {
  const normalized = {
    filter: {
      selectors: wire.filter.selectors.map((selector) => ({
        tags: selector.tags.map(normalizePredicate),
      })),
      ...(wire.filter.require.length > 0
        ? { require: wire.filter.require.map(normalizePredicate) }
        : {}),
      ...(wire.filter.exclude.length > 0
        ? { exclude: wire.filter.exclude.map(normalizePredicate) }
        : {}),
      ...(wire.filter.elementTypes.length > 0 ? { elementTypes: wire.filter.elementTypes } : {}),
    },
    spatial_constraint: normalizeSpatial(wire.spatial_constraint),
    time_constraint: normalizeTime(wire.time_constraint),
    sort_by: wire.sort_by,
    unmapped_attributes: wire.unmapped_attributes,
    confidence: wire.confidence,
    explanation: wire.explanation,
  };

  return SearchIntentSchema.parse(normalized);
}
