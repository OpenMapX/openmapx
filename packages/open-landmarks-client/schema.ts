import z from "zod/v4";

/**
 * The Open Landmarks v1 static API, as published by Open Landmarks and by
 * Barrelman Landmarks. Records keep unknown fields so provider normalizers can
 * read provider-specific ones (`credits`, `rightsStatus`, `approved`, …).
 */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const bounds = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const pointerSchema = z.looseObject({
  schemaVersion: z.literal(1),
  channel: z.string(),
  release: z.string().nullable(),
  catalogue: z.string().nullable(),
  count: z.number().int().nonnegative(),
  status: z.string().optional(),
});
export type OpenLandmarksPointer = z.infer<typeof pointerSchema>;

export const catalogueSchema = z.looseObject({
  schemaVersion: z.literal(1),
  release: z.string(),
  count: z.number().int().nonnegative(),
  assets: z.string(),
});
export type OpenLandmarksCatalogue = z.infer<typeof catalogueSchema>;

const gzipDescriptor = z.looseObject({
  url: z.string(),
  bytes: z.number().int().positive(),
  sha256,
});

const lod = z.looseObject({
  url: z.string(),
  bytes: z.number().int().positive(),
  sha256,
  triangles: z.number().int().nonnegative().optional(),
  gzip: gzipDescriptor,
});

const osmRef = z.looseObject({
  type: z.enum(["node", "way", "relation"]),
  id: z.number().int().positive(),
});

const ring = z.array(lngLat).min(4);
const footprint = z.union([
  z.looseObject({ type: z.literal("Polygon"), coordinates: z.array(ring).min(1) }),
  z.looseObject({
    type: z.literal("MultiPolygon"),
    coordinates: z.array(z.array(ring).min(1)).min(1),
  }),
]);

export const assetRecordSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  revision: z.string().optional(),
  anchor: lngLat,
  heading: z.number(),
  units: z.string(),
  axes: z.string(),
  bounds,
  minZoom: z.number().optional(),
  detailZoom: z.number().optional(),
  lods: z.looseObject({ low: lod, detail: lod.optional() }),
  osm: osmRef.nullable().optional(),
  additionalOsm: z.array(osmRef).optional(),
  wikidata: z.string().optional(),
  height: z.number().optional(),
  elevation: z.number().optional(),
  replacementFootprint: footprint.optional(),
  artisticLicense: z.string().min(1),
  attribution: z.string().optional(),
  authors: z.array(z.string()).optional(),
});
export type OpenLandmarksAssetRecord = z.infer<typeof assetRecordSchema>;

/** Records stay unvalidated here so one bad record cannot reject the whole release. */
export const assetsDocumentSchema = z.looseObject({
  schemaVersion: z.literal(1),
  release: z.string(),
  assets: z.array(z.unknown()),
});
export type OpenLandmarksAssetsDocument = z.infer<typeof assetsDocumentSchema>;
