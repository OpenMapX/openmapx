DROP TABLE "data_manager"."poi_feed_state" CASCADE;--> statement-breakpoint
DROP SCHEMA IF EXISTS "poi_ingest" CASCADE;--> statement-breakpoint
DELETE FROM "data_manager"."jobs" WHERE "kind" LIKE 'poi-ingest:%';