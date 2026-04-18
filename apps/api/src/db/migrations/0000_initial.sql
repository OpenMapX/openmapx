CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "integration_config" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integrationConfig_integrationId_unq" UNIQUE("integration_id")
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
CREATE TABLE "labeled_place" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"icon" text,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"place_id" text,
	CONSTRAINT "labeledPlace_userId_label_unq" UNIQUE("user_id","label")
);
--> statement-breakpoint
CREATE TABLE "mangrove_keypair" (
	"user_id" text PRIMARY KEY NOT NULL,
	"encryption_mode" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_jwk" jsonb,
	"passphrase_ciphertext" text,
	"recipients_ciphertext" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mangrove_keypair_wrap" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"wrap_type" text NOT NULL,
	"label" text NOT NULL,
	"identity_string" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "saved_list" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"is_private" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "savedList_userId_name_unq" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "saved_place" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"place_id" text,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	"normalized_email" text,
	"two_factor_enabled" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_normalized_email_unique" UNIQUE("normalized_email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_job" ADD CONSTRAINT "admin_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_job_log" ADD CONSTRAINT "admin_job_log_job_id_admin_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."admin_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_integration" ADD CONSTRAINT "installed_integration_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_secret" ADD CONSTRAINT "integration_secret_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labeled_place" ADD CONSTRAINT "labeled_place_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mangrove_keypair" ADD CONSTRAINT "mangrove_keypair_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mangrove_keypair_wrap" ADD CONSTRAINT "mangrove_keypair_wrap_user_id_mangrove_keypair_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."mangrove_keypair"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_list" ADD CONSTRAINT "saved_list_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_place" ADD CONSTRAINT "saved_place_list_id_saved_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."saved_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
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
CREATE INDEX "integrationConfig_integrationId_idx" ON "integration_config" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "integrationSecret_integrationId_idx" ON "integration_secret" USING btree ("integration_id");--> statement-breakpoint
CREATE INDEX "labeledPlace_userId_idx" ON "labeled_place" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "savedList_userId_idx" ON "saved_list" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "savedPlace_listId_idx" ON "saved_place" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");