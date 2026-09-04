CREATE TABLE "data_export_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"generation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'assembling' NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text DEFAULT 'application/zip' NOT NULL,
	"plaintext_bytes" integer,
	"encrypted_bytes" integer,
	"plaintext_sha256" text,
	"ciphertext_sha256" text,
	"cipher_version" integer DEFAULT 1 NOT NULL,
	"aad_version" integer DEFAULT 1 NOT NULL,
	"iv" text NOT NULL,
	"tag" text,
	"wrapped_dek" text,
	"master_key_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"download_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "data_export_artifact_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "data_export_artifact_download_count_check" CHECK ("data_export_artifact"."download_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "data_subject_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"user_id" text,
	"actor_user_id" text,
	"actor_session_id" text,
	"encrypted_locator" text NOT NULL,
	"locator_digest" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"state" text DEFAULT 'received' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"preservation_at" timestamp with time zone,
	"snapshot_at" timestamp with time zone,
	"due_at" timestamp with time zone NOT NULL,
	"extension" jsonb,
	"identity_state" text DEFAULT 'pending' NOT NULL,
	"refusal_code" text,
	"refusal_reason" text,
	"delivery_state" text DEFAULT 'not_delivered' NOT NULL,
	"withdrawal_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"protected_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_kind_check" CHECK ("data_subject_request"."kind" in ('access', 'access_and_portability')),
	CONSTRAINT "data_subject_request_channel_check" CHECK ("data_subject_request"."channel" in ('self_service', 'email', 'post', 'representative', 'internal')),
	CONSTRAINT "data_subject_request_state_check" CHECK ("data_subject_request"."state" in ('received', 'identity_pending', 'clarification_needed', 'collecting', 'review', 'ready', 'delivered', 'withdrawn', 'refused', 'closed')),
	CONSTRAINT "data_subject_request_version_check" CHECK ("data_subject_request"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"encrypted_bytes" integer NOT NULL,
	"plaintext_bytes" integer NOT NULL,
	"plaintext_sha256" text NOT NULL,
	"ciphertext_sha256" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text,
	"wrapped_dek" text,
	"master_key_version" integer,
	"owner_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"rights_review_state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_attachment_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_event_payload_version_check" CHECK ("data_subject_request_event"."payload_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_preservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"registration_id" text NOT NULL,
	"locator_digest" text NOT NULL,
	"source_cutoff_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"status" text DEFAULT 'held' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"registration_id" text NOT NULL,
	"collector_id" text,
	"collector_version" integer,
	"source" text NOT NULL,
	"required" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"assigned_to" text,
	"cutoff_at" timestamp with time zone,
	"collected_at" timestamp with time zone,
	"record_count" integer,
	"public_code" text,
	"encrypted_detail" text,
	"exception_code" text,
	"redaction_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_task_attempts_check" CHECK ("data_subject_request_task"."attempts" >= 0),
	CONSTRAINT "data_subject_request_task_required_check" CHECK ("data_subject_request_task"."required" in (0, 1))
);
--> statement-breakpoint
ALTER TABLE "data_export_artifact" ADD CONSTRAINT "data_export_artifact_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_actor_session_id_session_id_fk" FOREIGN KEY ("actor_session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_attachment" ADD CONSTRAINT "data_subject_request_attachment_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_attachment" ADD CONSTRAINT "data_subject_request_attachment_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_event" ADD CONSTRAINT "data_subject_request_event_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_preservation" ADD CONSTRAINT "data_subject_request_preservation_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_task" ADD CONSTRAINT "data_subject_request_task_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_task" ADD CONSTRAINT "data_subject_request_task_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_export_artifact_request_state_idx" ON "data_export_artifact" USING btree ("request_id","state");--> statement-breakpoint
CREATE INDEX "data_export_artifact_expiry_idx" ON "data_export_artifact" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_user_state_idx" ON "data_subject_request" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "data_subject_request_due_idx" ON "data_subject_request" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_locator_digest_idx" ON "data_subject_request" USING btree ("locator_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_active_user_kind_idx" ON "data_subject_request" USING btree ("user_id","kind") WHERE "data_subject_request"."user_id" is not null and "data_subject_request"."state" not in ('withdrawn', 'refused', 'closed');--> statement-breakpoint
CREATE INDEX "data_subject_request_attachment_request_idx" ON "data_subject_request_attachment" USING btree ("request_id","purpose");--> statement-breakpoint
CREATE INDEX "data_subject_request_attachment_expiry_idx" ON "data_subject_request_attachment" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_event_request_idx" ON "data_subject_request_event" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_preservation_request_registration_idx" ON "data_subject_request_preservation" USING btree ("request_id","registration_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_preservation_locator_idx" ON "data_subject_request_preservation" USING btree ("registration_id","locator_digest","status");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_task_request_key_idx" ON "data_subject_request_task" USING btree ("request_id","task_key");--> statement-breakpoint
CREATE INDEX "data_subject_request_task_status_idx" ON "data_subject_request_task" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_task_registration_idx" ON "data_subject_request_task" USING btree ("registration_id");