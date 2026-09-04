CREATE TABLE "data_subject_request_notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"recipient_user_id" text,
	"template" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_notification_template_check" CHECK ("data_subject_request_notification"."template" in ('acknowledgement', 'clarification', 'extension', 'ready', 'delivered', 'closed', 'refused')),
	CONSTRAINT "data_subject_request_notification_channel_check" CHECK ("data_subject_request_notification"."channel" in ('email')),
	CONSTRAINT "data_subject_request_notification_state_check" CHECK ("data_subject_request_notification"."state" in ('pending', 'sending', 'sent', 'retryable', 'failed', 'canceled')),
	CONSTRAINT "data_subject_request_notification_attempts_check" CHECK ("data_subject_request_notification"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "data_subject_request_notification" ADD CONSTRAINT "data_subject_request_notification_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_notification" ADD CONSTRAINT "data_subject_request_notification_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_notification_event_idx" ON "data_subject_request_notification" USING btree ("request_id","template","channel");--> statement-breakpoint
CREATE INDEX "data_subject_request_notification_state_idx" ON "data_subject_request_notification" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "data_subject_request_notification_recipient_idx" ON "data_subject_request_notification" USING btree ("recipient_user_id","created_at");