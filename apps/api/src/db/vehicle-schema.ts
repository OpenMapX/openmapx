import type { EvVehicleSpec, ParkedSource, VehicleKind, VehiclePowertrain } from "@openmapx/core";
import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * A user's small garage. The EV spec is one JSON value rather than seven
 * columns: it is passed around whole by the charge planner and never queried
 * field-wise, so splitting it would declare its shape in a second place.
 */
export const personalVehicle = pgTable(
  "personal_vehicle",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<VehicleKind>().notNull(),
    powertrain: text("powertrain").$type<VehiclePowertrain>().notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    presetId: text("preset_id"),
    ev: jsonb("ev").$type<EvVehicleSpec | null>(),
    fuelConsumptionLPer100Km: doublePrecision("fuel_consumption_l_per_100km"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("personalVehicle_userId_idx").on(table.userId),
    unique("personalVehicle_userId_name_unq").on(table.userId, table.name),
  ],
);

/**
 * Where a vehicle is parked right now. One current record per vehicle, and one
 * for "no particular vehicle" — which is why the uniqueness is NULLS NOT
 * DISTINCT: without it Postgres treats every null `vehicle_id` as its own row
 * and the unassigned pin accumulates duplicates.
 *
 * Deleting a vehicle cascades. Nulling the column instead would collide with
 * this constraint whenever an unassigned record already exists, so a user who
 * had parked without picking a vehicle could not delete a car at all.
 */
export const parkedLocation = pgTable(
  "parked_location",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    vehicleId: text("vehicle_id").references(() => personalVehicle.id, { onDelete: "cascade" }),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    address: text("address"),
    note: text("note"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    source: text("source").$type<ParkedSource>().notNull(),
    accuracyMeters: doublePrecision("accuracy_meters"),
    savedAt: timestamp("saved_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("parkedLocation_userId_idx").on(table.userId),
    unique("parkedLocation_userId_vehicleId_unq")
      .on(table.userId, table.vehicleId)
      .nullsNotDistinct(),
  ],
);

export type PersonalVehicleRow = typeof personalVehicle.$inferSelect;
export type ParkedLocationRow = typeof parkedLocation.$inferSelect;
