CREATE TABLE "data_disclosure_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recipient_id" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_role" text NOT NULL,
	"recipient_country" text,
	"recipient_privacy_url" text,
	"integration_id" text,
	"operation_code" text NOT NULL,
	"category_code" text NOT NULL,
	"purpose_code" text NOT NULL,
	"legal_basis_code" text NOT NULL,
	"transfer_safeguard_code" text,
	"external_reference_digest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_disclosure_event_code_check" CHECK ("data_disclosure_event"."recipient_id" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and "data_disclosure_event"."operation_code" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and "data_disclosure_event"."category_code" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and "data_disclosure_event"."purpose_code" ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and "data_disclosure_event"."legal_basis_code" ~ '^[a-z0-9][a-z0-9._-]{0,127}$')
);
--> statement-breakpoint
ALTER TABLE "data_disclosure_event" ADD CONSTRAINT "data_disclosure_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_disclosure_event_user_occurred_idx" ON "data_disclosure_event" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "data_disclosure_event_recipient_idx" ON "data_disclosure_event" USING btree ("recipient_id","occurred_at");