DROP INDEX "data_subject_request_notification_event_idx";--> statement-breakpoint
ALTER TABLE "data_subject_request_notification" ADD COLUMN "occurrence_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_notification_event_idx" ON "data_subject_request_notification" USING btree ("request_id","template","channel","recipient_user_id","occurrence_key");