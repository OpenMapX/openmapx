-- The request lifecycle changes to five states without conversion: existing
-- requests and their events, tasks, holds and notifications are deleted.
DELETE FROM "data_subject_request";--> statement-breakpoint
ALTER TABLE "data_export_artifact" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_export_reauthentication" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_subject_request_attachment" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_subject_request_email_challenge" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_subject_request_identity" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "data_export_artifact" CASCADE;--> statement-breakpoint
DROP TABLE "data_export_reauthentication" CASCADE;--> statement-breakpoint
DROP TABLE "data_subject_request_attachment" CASCADE;--> statement-breakpoint
DROP TABLE "data_subject_request_email_challenge" CASCADE;--> statement-breakpoint
DROP TABLE "data_subject_request_identity" CASCADE;--> statement-breakpoint
ALTER TABLE "data_subject_request" DROP CONSTRAINT "data_subject_request_state_check";--> statement-breakpoint
ALTER TABLE "data_subject_request_notification" DROP CONSTRAINT "data_subject_request_notification_template_check";--> statement-breakpoint
DROP INDEX "data_subject_request_task_request_key_idx";--> statement-breakpoint
DROP INDEX "data_subject_request_task_registration_idx";--> statement-breakpoint
DROP INDEX "data_subject_request_active_user_kind_idx";--> statement-breakpoint
DROP INDEX "data_subject_request_notification_event_idx";--> statement-breakpoint
DROP INDEX "data_subject_request_preservation_locator_idx";--> statement-breakpoint
DROP INDEX "data_subject_request_task_status_idx";--> statement-breakpoint
ALTER TABLE "data_subject_request" ALTER COLUMN "encrypted_locator" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_subject_request" ALTER COLUMN "state" SET DEFAULT 'open';--> statement-breakpoint
ALTER TABLE "data_subject_request_task" ALTER COLUMN "status" SET DEFAULT 'open';--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD COLUMN "identity_method" text;--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD COLUMN "identity_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_subject_request_task" ADD COLUMN "resolution_code" text;--> statement-breakpoint
ALTER TABLE "data_subject_request_task" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_task_request_registration_idx" ON "data_subject_request_task" USING btree ("request_id","registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_active_user_kind_idx" ON "data_subject_request" USING btree ("user_id","kind") WHERE "data_subject_request"."user_id" is not null and "data_subject_request"."state" in ('open', 'in_progress', 'waiting_on_requester');--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_notification_event_idx" ON "data_subject_request_notification" USING btree ("request_id","template","channel","recipient_user_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_preservation_locator_idx" ON "data_subject_request_preservation" USING btree ("registration_id","status");--> statement-breakpoint
CREATE INDEX "data_subject_request_task_status_idx" ON "data_subject_request_task" USING btree ("status");--> statement-breakpoint
ALTER TABLE "data_subject_request_preservation" DROP COLUMN "locator_digest";--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_identity_check" CHECK (("data_subject_request"."identity_method" is null and "data_subject_request"."identity_verified_at" is null) or ("data_subject_request"."identity_method" in ('account_session', 'manual') and "data_subject_request"."identity_verified_at" is not null));--> statement-breakpoint
ALTER TABLE "data_subject_request" ADD CONSTRAINT "data_subject_request_state_check" CHECK ("data_subject_request"."state" in ('open', 'in_progress', 'waiting_on_requester', 'completed', 'refused'));--> statement-breakpoint
ALTER TABLE "data_subject_request_notification" ADD CONSTRAINT "data_subject_request_notification_template_check" CHECK ("data_subject_request_notification"."template" in ('acknowledgement', 'waiting_on_requester', 'extension', 'completed', 'refused', 'admin_new_request', 'admin_deadline'));--> statement-breakpoint
ALTER TABLE "data_subject_request_task" ADD CONSTRAINT "data_subject_request_task_status_check" CHECK ("data_subject_request_task"."status" in ('open', 'resolved'));