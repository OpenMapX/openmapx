CREATE TABLE "data_manager"."offline_package_artifact_references" (
	"principal" text NOT NULL,
	"package_id" text NOT NULL,
	"byte_length" bigint NOT NULL,
	"retained_at" timestamp with time zone NOT NULL,
	CONSTRAINT "offline_package_artifact_references_principal_package_id_pk" PRIMARY KEY("principal","package_id")
);
--> statement-breakpoint
CREATE TABLE "data_manager"."offline_package_job_owners" (
	"job_id" uuid NOT NULL,
	"principal" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "offline_package_job_owners_job_id_principal_pk" PRIMARY KEY("job_id","principal")
);
--> statement-breakpoint
CREATE TABLE "data_manager"."offline_package_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_key" text NOT NULL,
	"package_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"status" text NOT NULL,
	"manifest" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "data_manager"."offline_package_job_owners" ADD CONSTRAINT "offline_package_job_owners_job_id_offline_package_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "data_manager"."offline_package_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offline_package_artifact_refs_package_idx" ON "data_manager"."offline_package_artifact_references" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "offline_package_artifact_refs_principal_age_idx" ON "data_manager"."offline_package_artifact_references" USING btree ("principal","retained_at");--> statement-breakpoint
CREATE INDEX "offline_package_job_owners_principal_idx" ON "data_manager"."offline_package_job_owners" USING btree ("principal");--> statement-breakpoint
CREATE UNIQUE INDEX "offline_package_jobs_live_request_key_uq" ON "data_manager"."offline_package_jobs" USING btree ("request_key") WHERE "data_manager"."offline_package_jobs"."status" IN ('preparing', 'ready-to-download');--> statement-breakpoint
CREATE INDEX "offline_package_jobs_status_created_idx" ON "data_manager"."offline_package_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "offline_package_jobs_package_id_idx" ON "data_manager"."offline_package_jobs" USING btree ("package_id");