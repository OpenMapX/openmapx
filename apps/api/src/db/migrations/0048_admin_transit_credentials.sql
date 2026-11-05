CREATE TABLE "transit_credential_preview" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"authorization_ciphertext" text,
	"authorization_iv" text,
	"authorization_tag" text,
	"candidate_id" uuid,
	"credentials_revision" text,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transit_credential_preview_bounds" CHECK (octet_length("transit_credential_preview"."ciphertext") <= 1500000 and length("transit_credential_preview"."intent_fingerprint") = 64 and length("transit_credential_preview"."iv") = 16 and length("transit_credential_preview"."tag") = 24)
);
--> statement-breakpoint
ALTER TABLE "transit_credential_preview" ADD CONSTRAINT "transit_credential_preview_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transit_credential_preview_actor_key_uq" ON "transit_credential_preview" USING btree ("actor_id","operation_key");--> statement-breakpoint
CREATE INDEX "transit_credential_preview_expiry_idx" ON "transit_credential_preview" USING btree ("expires_at");