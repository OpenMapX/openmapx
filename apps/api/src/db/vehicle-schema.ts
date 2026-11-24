import type { EvVehicleSpec, ParkedSource, VehicleKind, VehiclePowertrain } from "@openmapx/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/** Unique per account; a write that repeats a vehicle name raises this constraint. */
export const PERSONAL_VEHICLE_NAME_UNIQUE = "personal_vehicle_user_id_name_key";

/**
 * A user's small garage. The EV spec is one JSON value rather than seven
 * columns: it is passed around whole by the charge planner and never queried
 * field-wise, so splitting it would declare its shape in a second place.
 */
export const personalVehicle = pgTable(
  "personal_vehicle",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id").notNull(),
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
    foreignKey({
      name: "personal_vehicle_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    unique(PERSONAL_VEHICLE_NAME_UNIQUE).on(table.userId, table.name),
    check("personal_vehicle_kind_check", sql`${table.kind} in ('car','motorcycle','bicycle')`),
    check(
      "personal_vehicle_powertrain_check",
      sql`${table.powertrain} in ('electric','plugin_hybrid','hybrid','petrol','diesel','other')`,
    ),
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
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id").notNull(),
    vehicleId: uuid("vehicle_id"),
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
    foreignKey({
      name: "parked_location_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "parked_location_vehicle_id_fkey",
      columns: [table.vehicleId],
      foreignColumns: [personalVehicle.id],
    }).onDelete("cascade"),
    unique("parked_location_user_id_vehicle_id_key")
      .on(table.userId, table.vehicleId)
      .nullsNotDistinct(),
    index("parked_location_vehicle_id_idx").on(table.vehicleId),
    index("parked_location_expires_at_idx")
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} is not null`),
    check("parked_location_source_check", sql`${table.source} in ('device','manual','arrival')`),
  ],
);

export type PersonalVehicleRow = typeof personalVehicle.$inferSelect;
export type ParkedLocationRow = typeof parkedLocation.$inferSelect;
