ALTER TABLE "data_subject_request_task" DROP CONSTRAINT "data_subject_request_task_attempts_check";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP CONSTRAINT "data_subject_request_task_required_check";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP CONSTRAINT "data_subject_request_task_assigned_to_user_id_fk";
--> statement-breakpoint
DROP INDEX "data_subject_request_locator_digest_idx";--> statement-breakpoint
ALTER TABLE "data_subject_request" DROP COLUMN "locator_digest";--> statement-breakpoint
ALTER TABLE "data_subject_request" DROP COLUMN "identity_state";--> statement-breakpoint
ALTER TABLE "data_subject_request" DROP COLUMN "refusal_reason";--> statement-breakpoint
ALTER TABLE "data_subject_request" DROP COLUMN "delivery_state";--> statement-breakpoint
ALTER TABLE "data_subject_request" DROP COLUMN "withdrawal_at";--> statement-breakpoint
ALTER TABLE "data_subject_request" DROP COLUMN "protected_notes_envelope";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "task_key";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "collector_id";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "collector_version";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "required";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "attempts";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "next_attempt_at";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "assigned_to";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "cutoff_at";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "collected_at";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "record_count";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "encrypted_detail";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "exception_code";--> statement-breakpoint
ALTER TABLE "data_subject_request_task" DROP COLUMN "redaction_code";