CREATE TABLE "personal_timeline_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"public_origin" text NOT NULL,
	"display_name" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"encryption_iv" text NOT NULL,
	"encryption_tag" text NOT NULL,
	"upstream_user_id" text,
	"upstream_email" text,
	"upstream_time_zone" text NOT NULL,
	"distance_unit" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	"last_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personalTimelineConnection_userId_unq" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "personal_timeline_connection" ADD CONSTRAINT "personal_timeline_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personalTimelineConnection_userId_idx" ON "personal_timeline_connection" USING btree ("user_id");