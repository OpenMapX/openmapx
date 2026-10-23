import z from "zod/v4";
import { CONNECTOR_STANDARDS, type EvVehicleSpec } from "../../../types/ev";
import { PARKED_SOURCES, VEHICLE_KINDS, VEHICLE_POWERTRAINS } from "../../../vehicles/types";
import { MAX_VEHICLE_FUEL_L_PER_100KM, MAX_VEHICLE_NAME_LENGTH } from "../../../vehicles/validate";

const id = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const evFields = {
  batteryKwh: z.number().positive(),
  baseWhPerKm: z.number().positive(),
  massTonnes: z.number().positive(),
  maxDcKw: z.number().positive(),
  maxAcKw: z.number().nonnegative(),
  vehicleTaperSocPct: z.number().positive(),
  connectors: z.array(z.enum(CONNECTOR_STANDARDS)).min(1),
};
export const garageEvSpecSchema = z.strictObject(evFields) satisfies z.ZodType<EvVehicleSpec>;
const vehicleFields = {
  name: z.string().min(1).max(MAX_VEHICLE_NAME_LENGTH),
  kind: z.enum(VEHICLE_KINDS),
  powertrain: z.enum(VEHICLE_POWERTRAINS),
  isDefault: z.boolean(),
  presetId: z.string().nullable(),
  ev: garageEvSpecSchema.nullable(),
  fuelConsumptionLPer100Km: z.number().positive().max(MAX_VEHICLE_FUEL_L_PER_100KM).nullable(),
};
export const garageVehicleCreatedSchema = z.strictObject({ id, ...vehicleFields });
export const garageVehicleSchema = garageVehicleCreatedSchema.extend({
  createdAt: timestamp,
  updatedAt: timestamp,
});
const parkedFields = {
  vehicleId: id.nullable(),
  lat: latitude,
  lng: longitude,
  address: z.string().nullable(),
  note: z.string().nullable(),
  expiresAt: timestamp.nullable(),
  source: z.enum(PARKED_SOURCES),
  accuracyMeters: z.number().nonnegative().nullable(),
};
export const garageParkedSchema = z.strictObject({
  id,
  ...parkedFields,
  savedAt: timestamp,
  updatedAt: timestamp,
});

// Structural request validation precedes the existing domain normalizers. Optional
// fields have no schema defaults: PATCH must preserve omitted intent when merged.
export const garageCreateVehicleSchema = z.strictObject({
  name: z.string(),
  kind: vehicleFields.kind,
  powertrain: vehicleFields.powertrain,
  isDefault: z.boolean().optional(),
  presetId: z.string().nullable().optional(),
  ev: z
    .strictObject({
      ...evFields,
      massTonnes: evFields.massTonnes.optional(),
      maxAcKw: evFields.maxAcKw.optional(),
      vehicleTaperSocPct: evFields.vehicleTaperSocPct.optional(),
    })
    .nullable()
    .optional(),
  fuelConsumptionLPer100Km: vehicleFields.fuelConsumptionLPer100Km.optional(),
});
export const garageUpdateVehicleSchema = garageCreateVehicleSchema.partial();
export const garageSaveParkedSchema = z.strictObject({
  vehicleId: z.string().nullable().optional(),
  lat: latitude,
  lng: longitude,
  address: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  // The domain normalizer owns date parsing and the write-only future horizon.
  expiresAt: z.string().nullable().optional(),
  source: parkedFields.source,
  accuracyMeters: parkedFields.accuracyMeters.optional(),
});
export const garageUpdateParkedSchema = garageSaveParkedSchema
  .pick({
    lat: true,
    lng: true,
    address: true,
    note: true,
    expiresAt: true,
  })
  .partial();
export const garageIdParamsSchema = z.object({ id });
export const garageOkSchema = z.strictObject({ ok: z.literal(true) });
export const garageVehiclesSchema = z.strictObject({ vehicles: z.array(garageVehicleSchema) });
export const garageParkingSchema = z.strictObject({ parked: z.array(garageParkedSchema) });
export const garageNoStoreHeadersSchema = z.object({ "cache-control": z.literal("no-store") });

export type PersonalVehicle = z.infer<typeof garageVehicleSchema>;
export type ParkedLocation = z.infer<typeof garageParkedSchema>;
export type VehicleCreated = z.infer<typeof garageVehicleCreatedSchema>;
export type CreateVehicleInput = z.infer<typeof garageCreateVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof garageUpdateVehicleSchema>;
export type SaveParkedInput = z.infer<typeof garageSaveParkedSchema>;
export type UpdateParkedInput = z.infer<typeof garageUpdateParkedSchema>;
