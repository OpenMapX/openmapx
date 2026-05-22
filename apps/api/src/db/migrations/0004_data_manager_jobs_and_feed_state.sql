CREATE SCHEMA "data_manager";
--> statement-breakpoint
CREATE TABLE "data_manager"."feed_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region" text NOT NULL,
	"name" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_imported_at" timestamp with time zone,
	"hash" text,
	"validation_status" text,
	"validation_message" text,
	"status" text DEFAULT 'unknown' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_manager"."job_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"message" text,
	"error" jsonb,
	"artifacts" jsonb
);
--> statement-breakpoint
CREATE TABLE "data_manager"."jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"triggered_by" text,
	"idempotency_key" text,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "data_manager"."job_stages" ADD CONSTRAINT "job_stages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "data_manager"."jobs"("id") ON DELETE cascade ON UPDATE no action;