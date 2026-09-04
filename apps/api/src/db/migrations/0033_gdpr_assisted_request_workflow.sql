CREATE TABLE "data_subject_request_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"party" text NOT NULL,
	"contact_envelope" text,
	"contact_digest" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"reasonable_doubt_code" text,
	"evidence_attachment_id" uuid,
	"authority_state" text DEFAULT 'not_applicable' NOT NULL,
	"authority_attachment_id" uuid,
	"delivery_authorized" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_identity_party_check" CHECK ("data_subject_request_identity"."party" in ('subject', 'representative')),
	CONSTRAINT "data_subject_request_identity_state_check" CHECK ("data_subject_request_identity"."state" in ('pending', 'verified', 'failed', 'clarification')),
	CONSTRAINT "data_subject_request_identity_method_check" CHECK ("data_subject_request_identity"."method" is null or "data_subject_request_identity"."method" in ('account_login', 'verified_email_challenge', 'exceptional_evidence')),
	CONSTRAINT "data_subject_request_identity_authority_check" CHECK ("data_subject_request_identity"."authority_state" in ('not_applicable', 'pending', 'approved', 'rejected')),
	CONSTRAINT "data_subject_request_identity_delivery_check" CHECK ("data_subject_request_identity"."delivery_authorized" in (0, 1) and ("data_subject_request_identity"."delivery_authorized" = 0 or ("data_subject_request_identity"."party" = 'representative' and "data_subject_request_identity"."authority_state" = 'approved' and "data_subject_request_identity"."state" = 'verified')))
);
--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD COLUMN "locator_type" text DEFAULT 'user_id' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD COLUMN "account_state" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_subject_request_identity" ADD CONSTRAINT "data_subject_request_identity_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_identity" ADD CONSTRAINT "data_subject_request_identity_evidence_attachment_id_data_subject_request_attachment_id_fk" FOREIGN KEY ("evidence_attachment_id") REFERENCES "public"."data_subject_request_attachment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_identity" ADD CONSTRAINT "data_subject_request_identity_authority_attachment_id_data_subject_request_attachment_id_fk" FOREIGN KEY ("authority_attachment_id") REFERENCES "public"."data_subject_request_attachment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_identity" ADD CONSTRAINT "data_subject_request_identity_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_identity_party_idx" ON "data_subject_request_identity" USING btree ("request_id","party");--> statement-breakpoint
CREATE INDEX "data_subject_request_identity_state_idx" ON "data_subject_request_identity" USING btree ("state","authority_state");--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_locator_type_check" CHECK ("data_subject_request"."locator_type" in ('user_id', 'email', 'username', 'erasure_reference', 'other_reference'));--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_account_state_check" CHECK ("data_subject_request"."account_state" in ('current', 'inaccessible', 'deleted', 'unknown'));--> statement-breakpoint
ALTER TABLE "data_subject_request_attachment" ADD CONSTRAINT "data_subject_request_attachment_purpose_check" CHECK ("data_subject_request_attachment"."purpose" in ('identity_evidence', 'representative_authority', 'processor_response', 'operator_supplement'));