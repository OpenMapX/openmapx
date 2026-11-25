import { SESSION_LOCAL_PLACE_ID_SCHEMES } from "@openmapx/core/place-ids";
import type { SavedPlaceFieldContributors } from "@openmapx/core/saved-place-contributors";
import { relations, type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/** The format `field_contributors` is written in. */
export const FIELD_CONTRIBUTORS_VERSION = 1;

/** The contributor columns for a write: the receipts and, exactly when they
 * are set, their format. */
export function fieldContributorsColumns(
  fieldContributors: SavedPlaceFieldContributors | null | undefined,
): {
  fieldContributors: SavedPlaceFieldContributors | null;
  fieldContributorsVersion: number | null;
} {
  return fieldContributors
    ? { fieldContributors, fieldContributorsVersion: FIELD_CONTRIBUTORS_VERSION }
    : { fieldContributors: null, fieldContributorsVersion: null };
}

/** A stored place id names a durable record: `scheme:value` in the id
 * grammar, never one of the client's session-local schemes. */
function persistedPlaceId(column: AnyPgColumn): SQL {
  const sessionLocal = SESSION_LOCAL_PLACE_ID_SCHEMES.map((scheme) => `'${scheme}'`).join(", ");
  return sql`${column} ~ '^[a-z][a-z0-9-]*:.+' and split_part(${column}, ':', 1) not in (${sql.raw(sessionLocal)})`;
}

/** Unique per account; a write that repeats a list name raises this constraint. */
export const SAVED_LIST_NAME_UNIQUE = "saved_list_user_id_name_key";

export const savedList = pgTable(
  "saved_list",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    isPrivate: boolean("is_private").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "saved_list_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    unique(SAVED_LIST_NAME_UNIQUE).on(table.userId, table.name),
  ],
);

export const savedPlace = pgTable(
  "saved_place",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    listId: uuid("list_id").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    placeId: text("place_id"),
    fieldContributors: jsonb("field_contributors").$type<SavedPlaceFieldContributors>(),
    fieldContributorsVersion: smallint("field_contributors_version"),
    note: text("note"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "saved_place_list_id_fkey",
      columns: [table.listId],
      foreignColumns: [savedList.id],
    }).onDelete("cascade"),
    index("saved_place_list_id_idx").on(table.listId),
    check("saved_place_place_id_check", persistedPlaceId(table.placeId)),
    check("saved_place_lat_check", sql`${table.lat} between -90 and 90`),
    check("saved_place_lng_check", sql`${table.lng} between -180 and 180`),
    check(
      "saved_place_field_contributors_version_check",
      sql`(${table.fieldContributors} is null) = (${table.fieldContributorsVersion} is null) and (${table.fieldContributorsVersion} is null or ${table.fieldContributorsVersion} = 1)`,
    ),
  ],
);

export const labeledPlace = pgTable(
  "labeled_place",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id").notNull(),
    label: text("label").notNull(),
    icon: text("icon"),
    name: text("name").notNull(),
    address: text("address"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    placeId: text("place_id"),
    fieldContributors: jsonb("field_contributors").$type<SavedPlaceFieldContributors>(),
    fieldContributorsVersion: smallint("field_contributors_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "labeled_place_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    unique("labeled_place_user_id_label_key").on(table.userId, table.label),
    check("labeled_place_place_id_check", persistedPlaceId(table.placeId)),
    check("labeled_place_lat_check", sql`${table.lat} between -90 and 90`),
    check("labeled_place_lng_check", sql`${table.lng} between -180 and 180`),
    check(
      "labeled_place_field_contributors_version_check",
      sql`(${table.fieldContributors} is null) = (${table.fieldContributorsVersion} is null) and (${table.fieldContributorsVersion} is null or ${table.fieldContributorsVersion} = 1)`,
    ),
  ],
);

export const savedListRelations = relations(savedList, ({ one, many }) => ({
  user: one(user, {
    fields: [savedList.userId],
    references: [user.id],
  }),
  places: many(savedPlace),
}));

export const savedPlaceRelations = relations(savedPlace, ({ one }) => ({
  list: one(savedList, {
    fields: [savedPlace.listId],
    references: [savedList.id],
  }),
}));

export const labeledPlaceRelations = relations(labeledPlace, ({ one }) => ({
  user: one(user, {
    fields: [labeledPlace.userId],
    references: [user.id],
  }),
}));
