import type { SavedPlaceFieldContributors } from "@openmapx/core/saved-place-contributors";
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

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
    note: text("note"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "saved_place_list_id_fkey",
      columns: [table.listId],
      foreignColumns: [savedList.id],
    }).onDelete("cascade"),
    index("saved_place_list_id_idx").on(table.listId),
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
  },
  (table) => [
    foreignKey({
      name: "labeled_place_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    unique("labeled_place_user_id_label_key").on(table.userId, table.label),
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
