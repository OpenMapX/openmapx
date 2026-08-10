CREATE TABLE "mobile_auth_handoff" (
	"id" text PRIMARY KEY NOT NULL,
	"callback_code_hash" text NOT NULL,
	"code_challenge" text NOT NULL,
	"state" text NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text NOT NULL,
	"one_time_token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "mobile_auth_handoff_callback_code_hash_unique" UNIQUE("callback_code_hash")
);
--> statement-breakpoint
ALTER TABLE "mobile_auth_handoff" ADD CONSTRAINT "mobile_auth_handoff_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mobile_auth_handoff_user_expires_idx" ON "mobile_auth_handoff" USING btree ("user_id","expires_at");
