CREATE TABLE "admin_action_reauthentication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"starting_session_id" text NOT NULL,
	"purpose" text NOT NULL,
	"target_id" text NOT NULL,
	"intent_fingerprint" text,
	"nonce_digest" text NOT NULL,
	"request_key" text,
	"auth_policy_revision" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"completed_session_id" text,
	"completed_method" text,
	"completed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_reauth_state_check" CHECK ("admin_action_reauthentication"."state" in ('pending','completed','consumed','superseded','expired')),
	CONSTRAINT "admin_reauth_purpose_check" CHECK ("admin_action_reauthentication"."purpose" in ('account.verify','account.password.set','account.reset.send','account.invite','credentials.export','credentials.import','transit.credentials','platform.domain.apply'))
);
--> statement-breakpoint
ALTER TABLE "session_auth_assurance" ADD COLUMN "origin_independent_password_login" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_action_reauthentication" ADD CONSTRAINT "admin_action_reauthentication_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_reauth_actor_expiry_idx" ON "admin_action_reauthentication" USING btree ("actor_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_reauth_request_uq" ON "admin_action_reauthentication" USING btree ("actor_id","request_key");