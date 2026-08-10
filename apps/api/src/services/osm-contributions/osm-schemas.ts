/**
 * Zod schemas for the OSM v0.6 JSON responses the contribution boundary reads.
 *
 * Upstream may add fields, so objects are permissive about *unknown* keys but
 * strict about every value policy depends on. Defensive bounds (tag counts,
 * node/member counts, coordinate ranges) turn a hostile or corrupt response
 * into `UPSTREAM_INVALID` instead of an unbounded allocation.
 */
import { z } from "zod";

/** Defensive ceilings. An element beyond these is simply not directly editable. */
export const MAX_TAGS = 5_000;
export const MAX_REFS = 50_000;

const safeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const safeVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

const tagsSchema = z
  .record(z.string().min(1), z.string())
  .refine((tags) => Object.keys(tags).length <= MAX_TAGS, { message: "too many tags" });

export const osmPermissionsResponseSchema = z.object({
  permissions: z.array(z.string()).max(64),
});

export const osmUserDetailsResponseSchema = z.object({
  user: z
    .object({
      id: safeId,
      display_name: z.string().min(1).max(255),
      contributor_terms: z.object({ agreed: z.boolean() }).loose(),
      blocks: z
        .object({ received: z.object({ active: z.number().int().min(0) }).loose() })
        .loose()
        .optional(),
      img: z.object({ href: z.string() }).loose().optional(),
    })
    .loose(),
});

const nodeSchema = z
  .object({
    type: z.literal("node"),
    id: safeId,
    version: safeVersion,
    lat: latitude,
    lon: longitude,
    visible: z.boolean().optional(),
    changeset: safeId.optional(),
    tags: tagsSchema.optional(),
  })
  .loose();

const waySchema = z
  .object({
    type: z.literal("way"),
    id: safeId,
    version: safeVersion,
    nodes: z.array(safeId).max(MAX_REFS),
    visible: z.boolean().optional(),
    changeset: safeId.optional(),
    tags: tagsSchema.optional(),
  })
  .loose();

const relationSchema = z
  .object({
    type: z.literal("relation"),
    id: safeId,
    version: safeVersion,
    members: z
      .array(
        z
          .object({
            type: z.enum(["node", "way", "relation"]),
            ref: safeId,
            role: z.string().max(255),
          })
          .loose(),
      )
      .max(MAX_REFS),
    visible: z.boolean().optional(),
    changeset: safeId.optional(),
    tags: tagsSchema.optional(),
  })
  .loose();

export const osmElementSchema = z.discriminatedUnion("type", [
  nodeSchema,
  waySchema,
  relationSchema,
]);

export const osmElementResponseSchema = z.object({
  elements: z.array(osmElementSchema).max(MAX_REFS + 1),
});

const changesetBodySchema = z.object({ id: safeId, open: z.boolean() }).loose();

/**
 * OSM has served a changeset both under `elements` and as a bare `changeset`
 * object across releases; accept either rather than pinning one shape.
 */
export const osmChangesetResponseSchema = z
  .object({
    elements: z.array(changesetBodySchema).max(16).optional(),
    changeset: changesetBodySchema.optional(),
  })
  .loose()
  .refine((value) => value.changeset !== undefined || (value.elements?.length ?? 0) > 0, {
    message: "no changeset in response",
  });

export const osmNoteResponseSchema = z
  .object({
    properties: z
      .object({
        id: safeId,
        status: z.enum(["open", "closed", "hidden"]),
      })
      .loose(),
  })
  .loose();

export type OsmElementJson = z.infer<typeof osmElementSchema>;
