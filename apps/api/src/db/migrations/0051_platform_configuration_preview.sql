CREATE TABLE "platform_configuration_preview" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"operation_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"preview_fingerprint" text NOT NULL,
	"auth_policy_revision" text NOT NULL,
	"source_revision" uuid NOT NULL,
	"expected_current_revision_id" text,
	"preview" jsonb NOT NULL,
	"consumed_by_job_id" uuid,
	"consumed_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_preview_bounds" CHECK (length("platform_configuration_preview"."operation_key") between 1 and 128 and "platform_configuration_preview"."request_fingerprint" ~ '^[a-f0-9]{64}$' and "platform_configuration_preview"."preview_fingerprint" ~ '^[a-f0-9]{64}$' and "platform_configuration_preview"."auth_policy_revision" ~ '^[a-f0-9]{64}$' and octet_length("platform_configuration_preview"."preview"::text) <= 131072 and jsonb_typeof("platform_configuration_preview"."preview") = 'object' and "platform_configuration_preview"."expires_at" > "platform_configuration_preview"."created_at" and "platform_configuration_preview"."expires_at" <= "platform_configuration_preview"."created_at" + interval '10 minutes' and (("platform_configuration_preview"."consumed_at" is null) = ("platform_configuration_preview"."consumed_by_job_id" is null)) and ("platform_configuration_preview"."retired_at" is null or ("platform_configuration_preview"."consumed_at" is not null and "platform_configuration_preview"."retired_at" >= "platform_configuration_preview"."consumed_at")))
);
--> statement-breakpoint
ALTER TABLE "platform_configuration_preview" ADD CONSTRAINT "platform_configuration_preview_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_preview_actor_key_uq" ON "platform_configuration_preview" USING btree ("actor_id","operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_preview_fingerprint_uq" ON "platform_configuration_preview" USING btree ("preview_fingerprint");--> statement-breakpoint
CREATE INDEX "platform_preview_expiry_idx" ON "platform_configuration_preview" USING btree ("expires_at");