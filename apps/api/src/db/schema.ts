import { integer, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Custom POIs added by users (Phase 4).
 * OSM POIs are fetched at query-time; only user-created entries live here.
 */
export const customPois = pgTable("custom_pois", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address").notNull(),
  category: text("category"),
  lng: real("lng").notNull(),
  lat: real("lat").notNull(),
  phone: text("phone"),
  website: text("website"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Cached geocoding results to reduce Pelias load (Phase 3).
 */
export const geocodeCache = pgTable("geocode_cache", {
  query: text("query").primaryKey(),
  resultJson: text("result_json").notNull(),
  hitCount: integer("hit_count").default(1).notNull(),
  cachedAt: timestamp("cached_at").defaultNow().notNull(),
});
