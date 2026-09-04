CREATE TABLE "data_export_reauthentication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"user_id" text,
	"initiating_admin_user_id" text,
	"initiating_admin_session_id" text,
	"starting_session_id" text,
	"nonce_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_session_id" text,
	"completed_method" text,
	"completed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_export_reauthentication_state_check" CHECK ("data_export_reauthentication"."state" in ('pending', 'completed', 'consumed', 'superseded', 'expired')),
	CONSTRAINT "data_export_reauthentication_method_check" CHECK ("data_export_reauthentication"."completed_method" is null or "data_export_reauthentication"."completed_method" in ('password', 'password_totp', 'password_recovery', 'passkey', 'federated'))
);
--> statement-breakpoint
CREATE TABLE "session_auth_assurance" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"method" text NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_auth_assurance_method_check" CHECK ("session_auth_assurance"."method" in ('password', 'password_totp', 'password_recovery', 'passkey', 'federated'))
);
--> statement-breakpoint
ALTER TABLE "data_export_reauthentication" ADD CONSTRAINT "data_export_reauthentication_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_reauthentication" ADD CONSTRAINT "data_export_reauthentication_artifact_id_data_export_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."data_export_artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_reauthentication" ADD CONSTRAINT "data_export_reauthentication_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_reauthentication" ADD CONSTRAINT "data_export_reauthentication_initiating_admin_user_id_user_id_fk" FOREIGN KEY ("initiating_admin_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_reauthentication" ADD CONSTRAINT "data_export_reauthentication_initiating_admin_session_id_session_id_fk" FOREIGN KEY ("initiating_admin_session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_auth_assurance" ADD CONSTRAINT "session_auth_assurance_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_auth_assurance" ADD CONSTRAINT "session_auth_assurance_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_export_reauthentication_user_expiry_idx" ON "data_export_reauthentication" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "data_export_reauthentication_artifact_state_idx" ON "data_export_reauthentication" USING btree ("artifact_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "data_export_reauthentication_active_idx" ON "data_export_reauthentication" USING btree ("request_id","artifact_id","user_id") WHERE "data_export_reauthentication"."state" in ('pending', 'completed');--> statement-breakpoint
CREATE INDEX "session_auth_assurance_user_idx" ON "session_auth_assurance" USING btree ("user_id","authenticated_at");