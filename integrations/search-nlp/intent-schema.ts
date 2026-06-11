import { z } from "zod/v4";

const spatialConstraint = z.union([
  z.object({ type: z.literal("near_place"), place_name: z.string() }),
  z.object({ type: z.literal("near_coordinates"), lat: z.number(), lng: z.number() }),
  z.object({
    type: z.literal("within_bbox"),
    south: z.number(),
    west: z.number(),
    north: z.number(),
    east: z.number(),
  }),
  z.object({ type: z.literal("current_view") }),
]);

const timeConstraint = z.union([
  z.object({ type: z.literal("open_now") }),
  z.object({ type: z.literal("open_at"), day: z.string(), time: z.string() }),
  z.object({ type: z.literal("open_24h") }),
]);

export const SearchIntentSchema = z.object({
  categories: z.array(z.string()),
  attributes: z.record(z.string(), z.string()),
  spatial_constraint: spatialConstraint.nullable(),
  time_constraint: timeConstraint.nullable(),
  sort_by: z.enum(["relevance", "distance", "rating"]),
  unmapped_attributes: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
});

export type SearchIntentParsed = z.infer<typeof SearchIntentSchema>;

export const searchIntentJsonSchema = {
  type: "object",
  properties: {
    categories: {
      type: "array",
      items: { type: "string" },
      description: "Category IDs matched from the available categories list",
    },
    attributes: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "OSM attribute tag key/value filters (string values only)",
    },
    spatial_constraint: {
      anyOf: [
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["near_place"] },
            place_name: { type: "string" },
          },
          required: ["type", "place_name"],
        },
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["near_coordinates"] },
            lat: { type: "number" },
            lng: { type: "number" },
          },
          required: ["type", "lat", "lng"],
        },
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["within_bbox"] },
            south: { type: "number" },
            west: { type: "number" },
            north: { type: "number" },
            east: { type: "number" },
          },
          required: ["type", "south", "west", "north", "east"],
        },
        {
          type: "object",
          properties: { type: { type: "string", enum: ["current_view"] } },
          required: ["type"],
        },
        { type: "null" },
      ],
    },
    time_constraint: {
      anyOf: [
        {
          type: "object",
          properties: { type: { type: "string", enum: ["open_now"] } },
          required: ["type"],
        },
        {
          type: "object",
          properties: {
            type: { type: "string", enum: ["open_at"] },
            day: { type: "string", description: "Day name e.g. Monday" },
            time: { type: "string", description: "24h time e.g. 09:00" },
          },
          required: ["type", "day", "time"],
        },
        {
          type: "object",
          properties: { type: { type: "string", enum: ["open_24h"] } },
          required: ["type"],
        },
        { type: "null" },
      ],
    },
    sort_by: {
      type: "string",
      enum: ["relevance", "distance", "rating"],
    },
    unmapped_attributes: {
      type: "array",
      items: { type: "string" },
      description: "Qualities with no OSM tag (e.g. quiet, cozy, cheap)",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    explanation: {
      type: "string",
      description: "Short human-readable summary of the parsed intent",
    },
  },
  required: [
    "categories",
    "attributes",
    "spatial_constraint",
    "time_constraint",
    "sort_by",
    "unmapped_attributes",
    "confidence",
    "explanation",
  ],
} as const;
