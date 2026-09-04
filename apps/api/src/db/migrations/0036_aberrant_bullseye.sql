CREATE TABLE "data_subject_request_source_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"registration_id" text NOT NULL,
	"state" text DEFAULT 'captured' NOT NULL,
	"format" text DEFAULT 'subject-record-jsonl-v1' NOT NULL,
	"storage_key" text NOT NULL,
	"record_count" integer NOT NULL,
	"plaintext_bytes" integer NOT NULL,
	"encrypted_bytes" integer NOT NULL,
	"plaintext_sha256" text NOT NULL,
	"ciphertext_sha256" text NOT NULL,
	"cipher_version" integer DEFAULT 1 NOT NULL,
	"aad_version" integer DEFAULT 1 NOT NULL,
	"iv" text NOT NULL,
	"tag" text,
	"wrapped_dek" text,
	"master_key_version" integer,
	"captured_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"delete_attempts" integer DEFAULT 0 NOT NULL,
	"last_delete_attempt_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_source_snapshot_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "data_subject_request_source_snapshot_state_check" CHECK ("data_subject_request_source_snapshot"."state" in ('captured', 'delete_failed', 'deleted')),
	CONSTRAINT "data_subject_request_source_snapshot_format_check" CHECK ("data_subject_request_source_snapshot"."format" = 'subject-record-jsonl-v1'),
	CONSTRAINT "data_subject_request_source_snapshot_counts_check" CHECK ("data_subject_request_source_snapshot"."record_count" >= 0 and "data_subject_request_source_snapshot"."plaintext_bytes" >= 0 and "data_subject_request_source_snapshot"."encrypted_bytes" >= 0 and "data_subject_request_source_snapshot"."delete_attempts" >= 0 and "data_subject_request_source_snapshot"."delete_attempts" <= 5)
);
--> statement-breakpoint
ALTER TABLE "data_subject_request_preservation" ADD COLUMN "outcome_code" text;--> statement-breakpoint
ALTER TABLE "data_subject_request_source_snapshot" ADD CONSTRAINT "data_subject_request_source_snapshot_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_source_snapshot_request_registration_idx" ON "data_subject_request_source_snapshot" USING btree ("request_id","registration_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_source_snapshot_expiry_idx" ON "data_subject_request_source_snapshot" USING btree ("state","expires_at");