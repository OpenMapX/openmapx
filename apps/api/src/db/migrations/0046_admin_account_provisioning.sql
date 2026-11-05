CREATE TABLE "account_action_receipt" (
	"key" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"target_id" text,
	"action" text NOT NULL,
	"intent_digest" text NOT NULL,
	"result" jsonb,
	"mail_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_key" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"ciphertext" text,
	"iv" text,
	"tag" text,
	"attempt_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_mail_state_check" CHECK ("account_mail_outbox"."state" in ('queued','sending','sent','failed','unknown')),
	CONSTRAINT "account_mail_kind_check" CHECK ("account_mail_outbox"."kind" in ('verification','password_setup'))
);
--> statement-breakpoint
ALTER TABLE "account_action_receipt" ADD CONSTRAINT "account_action_receipt_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_action_receipt" ADD CONSTRAINT "account_action_receipt_target_id_user_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mail_outbox" ADD CONSTRAINT "account_mail_outbox_request_key_account_action_receipt_key_fk" FOREIGN KEY ("request_key") REFERENCES "public"."account_action_receipt"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_mail_outbox" ADD CONSTRAINT "account_mail_outbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_action_actor_time_idx" ON "account_action_receipt" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "account_action_target_time_idx" ON "account_action_receipt" USING btree ("target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_mail_action_kind_uq" ON "account_mail_outbox" USING btree ("request_key","kind");--> statement-breakpoint
CREATE INDEX "account_mail_pending_idx" ON "account_mail_outbox" USING btree ("state","created_at");