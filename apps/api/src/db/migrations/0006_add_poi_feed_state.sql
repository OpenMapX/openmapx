CREATE TABLE "data_manager"."poi_feed_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"domain" text NOT NULL,
	"last_static_ingest_at" timestamp with time zone,
	"last_static_row_count" integer,
	"last_static_hash" text,
	"last_live_ingest_at" timestamp with time zone,
	"last_live_row_count" integer,
	"status" text DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	CONSTRAINT "poi_feed_state_source_id_unique" UNIQUE("source_id")
);
