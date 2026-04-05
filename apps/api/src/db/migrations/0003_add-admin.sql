CREATE TABLE "admin_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"target_id" text,
	"target_type" text,
	"action" text NOT NULL,
	"details" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_job" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"progress" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "admin_job_log" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"seq" integer NOT NULL,
	"stream" text DEFAULT 'stdout' NOT NULL,
	"line" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"source" text NOT NULL,
	"msg" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"status" text NOT NULL,
	"response_time" integer,
	"error" text,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installed_integration" (
	"id" text PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"installed_version" text NOT NULL,
	"source_type" text DEFAULT 'registry' NOT NULL,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"installed_by" text
);
--> statement-breakpoint
CREATE TABLE "integration_secret" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "integrationSecret_integrationId_key_unq" UNIQUE("integration_id","key")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_job" ADD CONSTRAINT "admin_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_job_log" ADD CONSTRAINT "admin_job_log_job_id_admin_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."admin_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_integration" ADD CONSTRAINT "installed_integration_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_secret" ADD CONSTRAINT "integration_secret_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_actorId_idx" ON "admin_audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "admin_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_createdAt_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "adminJob_status_idx" ON "admin_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "adminJob_type_idx" ON "admin_job" USING btree ("type");--> statement-breakpoint
CREATE INDEX "adminJob_createdAt_idx" ON "admin_job" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "adminJobLog_jobId_idx" ON "admin_job_log" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "app_logs_level_source_idx" ON "app_logs" USING btree ("level","source","created_at");--> statement-breakpoint
CREATE INDEX "healthHistory_serviceId_checkedAt_idx" ON "health_history" USING btree ("service_id","checked_at");--> statement-breakpoint
CREATE INDEX "installedIntegration_sourceType_idx" ON "installed_integration" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "integrationSecret_integrationId_idx" ON "integration_secret" USING btree ("integration_id");