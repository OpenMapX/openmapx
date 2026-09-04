CREATE TABLE "data_subject_request_email_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"purpose" text DEFAULT 'identity_verification' NOT NULL,
	"party" text NOT NULL,
	"recipient_source" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"recipient_envelope" text NOT NULL,
	"recipient_digest" text NOT NULL,
	"code_digest" text,
	"code_key_version" integer,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"max_delivery_attempts" integer DEFAULT 5 NOT NULL,
	"next_delivery_attempt_at" timestamp with time zone,
	"last_delivery_error_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_email_challenge_purpose_check" CHECK ("data_subject_request_email_challenge"."purpose" = 'identity_verification'),
	CONSTRAINT "data_subject_request_email_challenge_party_check" CHECK ("data_subject_request_email_challenge"."party" in ('subject', 'representative')),
	CONSTRAINT "data_subject_request_email_challenge_recipient_source_check" CHECK ("data_subject_request_email_challenge"."recipient_source" in ('live_account', 'request_locator', 'representative_contact')),
	CONSTRAINT "data_subject_request_email_challenge_state_check" CHECK ("data_subject_request_email_challenge"."state" in ('queued', 'sending', 'issued', 'retryable', 'failed', 'revoked', 'consumed', 'expired')),
	CONSTRAINT "data_subject_request_email_challenge_attempts_check" CHECK ("data_subject_request_email_challenge"."attempts" >= 0 and "data_subject_request_email_challenge"."max_attempts" > 0 and "data_subject_request_email_challenge"."attempts" <= "data_subject_request_email_challenge"."max_attempts"),
	CONSTRAINT "data_subject_request_email_challenge_delivery_attempts_check" CHECK ("data_subject_request_email_challenge"."delivery_attempts" >= 0 and "data_subject_request_email_challenge"."max_delivery_attempts" > 0 and "data_subject_request_email_challenge"."delivery_attempts" <= "data_subject_request_email_challenge"."max_delivery_attempts"),
	CONSTRAINT "data_subject_request_email_challenge_code_check" CHECK (("data_subject_request_email_challenge"."code_digest" is null and "data_subject_request_email_challenge"."code_key_version" is null) or ("data_subject_request_email_challenge"."code_digest" is not null and "data_subject_request_email_challenge"."code_key_version" > 0))
);
--> statement-breakpoint
DROP INDEX "data_subject_request_active_user_kind_idx";--> statement-breakpoint
ALTER TABLE "data_subject_request_email_challenge" ADD CONSTRAINT "data_subject_request_email_challenge_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_email_challenge" ADD CONSTRAINT "data_subject_request_email_challenge_identity_id_data_subject_request_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."data_subject_request_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_subject_request_email_challenge_request_idx" ON "data_subject_request_email_challenge" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_email_challenge_identity_idx" ON "data_subject_request_email_challenge" USING btree ("identity_id","created_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_email_challenge_delivery_idx" ON "data_subject_request_email_challenge" USING btree ("state","next_delivery_attempt_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_email_challenge_expiry_idx" ON "data_subject_request_email_challenge" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_email_challenge_active_identity_idx" ON "data_subject_request_email_challenge" USING btree ("identity_id") WHERE "data_subject_request_email_challenge"."state" in ('queued', 'sending', 'issued', 'retryable');--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_active_user_kind_idx" ON "data_subject_request" USING btree ("user_id","kind") WHERE "data_subject_request"."user_id" is not null and "data_subject_request"."state" not in ('withdrawn', 'refused', 'closed', 'delivered', 'artifact_expired');