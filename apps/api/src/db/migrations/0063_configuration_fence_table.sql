CREATE TABLE "data_manager"."configuration_fence" (
	"maintenance_id" uuid PRIMARY KEY NOT NULL,
	"fence_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"candidate_id" uuid NOT NULL,
	"plan_digest" text NOT NULL,
	"owner_certificate_digest" text NOT NULL,
	"input" jsonb NOT NULL,
	"state" text NOT NULL,
	"outcome" text,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "configuration_fence_fence_id_unique" UNIQUE("fence_id"),
	CONSTRAINT "configuration_fence_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "configuration_fence_state" CHECK (("data_manager"."configuration_fence"."state" = 'prepared' AND "data_manager"."configuration_fence"."outcome" IS NULL AND "data_manager"."configuration_fence"."settled_at" IS NULL) OR ("data_manager"."configuration_fence"."state" = 'settled' AND "data_manager"."configuration_fence"."outcome" IN ('applied','unused','contained') AND "data_manager"."configuration_fence"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
-- Configuration fences move from job rows to their own table.
DELETE FROM "data_manager"."jobs" WHERE "kind" = 'configuration-maintenance';--> statement-breakpoint
ALTER TABLE "data_manager"."jobs" DROP CONSTRAINT "data_manager_jobs_configuration_guard_shape";--> statement-breakpoint
DROP INDEX "data_manager"."data_manager_jobs_configuration_maintenance_uq";--> statement-breakpoint
DROP INDEX "data_manager"."data_manager_jobs_configuration_guard_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "configuration_fence_one_prepared_uq" ON "data_manager"."configuration_fence" USING btree ("state") WHERE "data_manager"."configuration_fence"."state" = 'prepared';