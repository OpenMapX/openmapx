import { licensingSchema } from "@openmapx/extension-contracts/licensing-schema";
import z from "zod/v4";
import { parseSavedPlaceContributors } from "../../../saved-place-contributors";
import { SAVED_EXPORT_FORMATS } from "../../../saved-place-export";

const id = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const integer = z.number().int().min(-2147483648).max(2147483647);
const receipt = z.strictObject({
  sourceId: z.string().min(1),
  name: z.string().min(1),
  url: z.string().optional(),
  licensing: licensingSchema.optional(),
  attributionText: z.string().optional(),
  publisher: z.strictObject({ name: z.string(), url: z.string().optional() }).optional(),
  retrievedAt: z.string().optional(),
  notes: z.string().optional(),
  modified: z.literal(true).optional(),
});
/** Explicit wire structure plus the established semantic/byte-budget boundary. */
export const savedFieldContributorsSchema = z
  .strictObject({
    name: z.array(receipt).max(32).readonly().optional(),
    address: z.array(receipt).max(32).readonly().optional(),
    lat: z.array(receipt).max(32).readonly().optional(),
    lng: z.array(receipt).max(32).readonly().optional(),
  })
  .refine((value) => parseSavedPlaceContributors(value) !== undefined, "Invalid fieldContributors");
const captured = savedFieldContributorsSchema.nullable().optional();
export const savedListSchema = z.strictObject({
  id,
  name: z.string(),
  icon: z.string().nullable(),
  isPrivate: z.boolean(),
  sortOrder: integer,
  placeCount: z.number().int().nonnegative().safe(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const location = {
  name: z.string(),
  address: z.string().nullable(),
  lat: latitude,
  lng: longitude,
  placeId: z.string().nullable(),
  fieldContributors: captured,
};
export const savedPlaceSchema = z.strictObject({
  id,
  listId: id,
  ...location,
  note: z.string().nullable(),
  sortOrder: integer,
  createdAt: timestamp,
});
export const labeledPlaceSchema = z.strictObject({
  id,
  label: z.string(),
  icon: z.string().nullable(),
  ...location,
});
export const savedListCreatedSchema = savedListSchema.pick({
  id: true,
  name: true,
  icon: true,
  isPrivate: true,
});
export const savedPlaceCreatedSchema = savedPlaceSchema.omit({ sortOrder: true, createdAt: true });
export const savedLabelWrittenSchema = z.strictObject({ id, label: z.string() });
export const savedOkSchema = z.strictObject({ ok: z.literal(true) });
export const savedListsResponseSchema = z.strictObject({ lists: z.array(savedListSchema) });
export const savedPlacesResponseSchema = z.strictObject({ places: z.array(savedPlaceSchema) });
export const savedLabelsResponseSchema = z.strictObject({ labels: z.array(labeledPlaceSchema) });
export const savedCheckResponseSchema = z.strictObject({ listIds: z.array(id) });
export const savedImportResultSchema = z.strictObject({
  listId: id,
  name: z.string(),
  imported: z.number().int().nonnegative().safe(),
  skippedDuplicates: z.number().int().nonnegative().safe(),
});
export const savedIdParamsSchema = z.object({ id });
export const savedLabelParamsSchema = z.object({ label: z.string().min(1) });
export const savedCheckQuerySchema = z.object({ placeId: z.string().min(1) });
export const savedExportQuerySchema = z.object({
  format: z.enum(SAVED_EXPORT_FORMATS).default("geojson"),
});
export const savedCreateListSchema = z.object({
  name: z.string().max(200),
  icon: z.string().max(50).optional(),
  isPrivate: z.boolean().optional(),
});
export const savedUpdateListSchema = savedCreateListSchema
  .partial()
  .extend({ icon: z.string().max(50).nullable().optional(), sortOrder: integer.optional() });
const placeInput = {
  name: z.string().max(500),
  address: z.string().max(500).nullable().optional(),
  lat: latitude,
  lng: longitude,
  placeId: z.string().max(200).nullable().optional(),
  fieldContributors: savedFieldContributorsSchema.optional(),
};
export const savedCreatePlaceSchema = z.object({
  ...placeInput,
  name: placeInput.name.min(1),
  note: z.string().max(2000).nullable().optional(),
});
export const savedUpdatePlaceSchema = savedCreatePlaceSchema
  .omit({ placeId: true, fieldContributors: true })
  .partial()
  .extend({ name: z.string().max(500).optional(), sortOrder: integer.optional() });
export const savedWriteLabelSchema = z.object({
  ...placeInput,
  icon: z.string().max(50).optional(),
});
export const savedImportSchema = z.strictObject({
  target: z.union([
    z.strictObject({ listId: id }),
    z.strictObject({ name: z.string().min(1).max(200).regex(/^[^$]/) }),
  ]),
  places: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(500),
        address: z.string().max(500).optional(),
        lat: latitude,
        lng: longitude,
        note: z.string().max(2000).optional(),
        fieldContributors: savedFieldContributorsSchema.optional(),
      }),
    )
    .min(1)
    .max(2000),
});
export type SavedList = z.infer<typeof savedListSchema>;
export type SavedPlace = z.infer<typeof savedPlaceSchema>;
export type LabeledPlace = z.infer<typeof labeledPlaceSchema>;
export type ImportPlacesInput = z.infer<typeof savedImportSchema>;
export type ImportPlacesResult = z.infer<typeof savedImportResultSchema>;

export type CreateSavedListInput = z.infer<typeof savedCreateListSchema>;
export type UpdateSavedListInput = z.infer<typeof savedUpdateListSchema>;
export type CreateSavedPlaceInput = z.infer<typeof savedCreatePlaceSchema>;
export type UpdateSavedPlaceInput = z.infer<typeof savedUpdatePlaceSchema>;
export type WriteSavedLabelInput = z.infer<typeof savedWriteLabelSchema>;
