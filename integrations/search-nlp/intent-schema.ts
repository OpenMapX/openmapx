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

const tagPredicate = z.object({
  key: z.string(),
  op: z.enum(["=", "~", "exists"]).optional(),
  value: z.string().optional(),
});

const filterSchema = z.object({
  selectors: z.array(z.object({ tags: z.array(tagPredicate) })),
  require: z.array(tagPredicate).optional(),
  exclude: z.array(tagPredicate).optional(),
  elementTypes: z.array(z.enum(["node", "way", "relation"])).optional(),
});

export const SearchIntentSchema = z.object({
  filter: filterSchema,
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
    filter: {
      type: "object",
      description:
        "Structured Overpass tag filter describing what to search for. " +
        "selectors are OR-ed (any selector matching a feature is a hit). " +
        "require and exclude predicates are AND-ed across all selectors.",
      properties: {
        selectors: {
          type: "array",
          description:
            "One or more tag groups, OR-ed together. Each selector must match at least one tag. " +
            "Example: [{tags:[{key:'amenity',op:'=',value:'cafe'}]}]",
          items: {
            type: "object",
            properties: {
              tags: {
                type: "array",
                description:
                  "Tag predicates that must ALL match for this selector (AND within a selector)",
                items: {
                  type: "object",
                  properties: {
                    key: {
                      type: "string",
                      description: "OSM tag key, e.g. amenity, shop, leisure",
                    },
                    op: {
                      type: "string",
                      enum: ["=", "~", "exists"],
                      description:
                        "Match operator: '=' exact value, '~' regex value, 'exists' key present (no value needed)",
                    },
                    value: { type: "string", description: "Tag value (omit for op='exists')" },
                  },
                  required: ["key"],
                },
              },
            },
            required: ["tags"],
          },
        },
        require: {
          type: "array",
          description:
            "Tag predicates that must ALL match on top of every selector (AND across all selectors). " +
            "Use for mandatory attributes like wheelchair=yes.",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              op: { type: "string", enum: ["=", "~", "exists"] },
              value: { type: "string" },
            },
            required: ["key"],
          },
        },
        exclude: {
          type: "array",
          description:
            "Tag predicates that must NOT match (excluded across all selectors). " +
            "Use to filter out unwanted sub-types.",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              op: { type: "string", enum: ["=", "~", "exists"] },
              value: { type: "string" },
            },
            required: ["key"],
          },
        },
        elementTypes: {
          type: "array",
          description: "Limit to specific OSM element types. Omit to search nodes and ways.",
          items: { type: "string", enum: ["node", "way", "relation"] },
        },
      },
      required: ["selectors"],
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
    "filter",
    "spatial_constraint",
    "time_constraint",
    "sort_by",
    "unmapped_attributes",
    "confidence",
    "explanation",
  ],
} as const;
