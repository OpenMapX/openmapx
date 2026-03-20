import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const savedList = pgTable(
  "saved_list",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    icon: text("icon"),
    isPrivate: boolean("is_private").default(true).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("savedList_userId_idx").on(table.userId),
    unique("savedList_userId_name_unq").on(table.userId, table.name),
  ],
);

export const savedPlace = pgTable(
  "saved_place",
  {
    id: text("id").primaryKey(),
    listId: text("list_id")
      .notNull()
      .references(() => savedList.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    placeId: text("place_id"),
    note: text("note"),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("savedPlace_listId_idx").on(table.listId)],
);

export const labeledPlace = pgTable(
  "labeled_place",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    icon: text("icon"),
    name: text("name").notNull(),
    address: text("address"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    placeId: text("place_id"),
  },
  (table) => [
    index("labeledPlace_userId_idx").on(table.userId),
    unique("labeledPlace_userId_label_unq").on(table.userId, table.label),
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
