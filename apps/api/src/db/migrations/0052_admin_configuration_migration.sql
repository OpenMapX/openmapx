CREATE TABLE "configuration_migration_preview" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_by_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "configuration_migration_preview_bounds" CHECK ("configuration_migration_preview"."kind" in ('migration','credentials') and length("configuration_migration_preview"."id") = 36 and "configuration_migration_preview"."intent_fingerprint" ~ '^[a-f0-9]{64}$' and octet_length("configuration_migration_preview"."ciphertext") <= 1572864 and length("configuration_migration_preview"."iv") = 16 and length("configuration_migration_preview"."tag") = 24 and "configuration_migration_preview"."expires_at" > "configuration_migration_preview"."created_at" and "configuration_migration_preview"."expires_at" <= "configuration_migration_preview"."created_at" + interval '10 minutes' and ("configuration_migration_preview"."consumed_by_job_id" is null or length("configuration_migration_preview"."consumed_by_job_id") = 36))
);
--> statement-breakpoint
ALTER TABLE "configuration_migration_preview" ADD CONSTRAINT "configuration_migration_preview_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "configuration_migration_preview_actor_kind_idx" ON "configuration_migration_preview" USING btree ("actor_id","kind");--> statement-breakpoint
CREATE INDEX "configuration_migration_preview_expiry_idx" ON "configuration_migration_preview" USING btree ("expires_at");