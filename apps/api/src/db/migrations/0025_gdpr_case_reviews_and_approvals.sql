CREATE TABLE "data_subject_request_backup_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"backup_id" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"platform_version" text NOT NULL,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "data_subject_request_backup_review_decision_check" CHECK ("data_subject_request_backup_review"."decision" in ('not_applicable', 'no_material_difference', 'extract', 'unavailable'))
);
--> statement-breakpoint
CREATE TABLE "data_subject_request_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"version" text NOT NULL,
	"approver_user_id" text,
	"approver_role" text NOT NULL,
	"decision" text NOT NULL,
	"findings_digest" text,
	"reviewed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_request_approval_scope_check" CHECK ("data_subject_request_approval"."scope" in ('legal-content', 'dsar-process', 'security-review')),
	CONSTRAINT "data_subject_request_approval_decision_check" CHECK ("data_subject_request_approval"."decision" in ('approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "data_subject_request_event" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "data_subject_request_backup_review" ADD CONSTRAINT "data_subject_request_backup_review_request_id_data_subject_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."data_subject_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_backup_review" ADD CONSTRAINT "data_subject_request_backup_review_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_request_approval" ADD CONSTRAINT "data_subject_request_approval_approver_user_id_user_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_backup_review_request_backup_idx" ON "data_subject_request_backup_review" USING btree ("request_id","backup_id");--> statement-breakpoint
CREATE INDEX "data_subject_request_backup_review_manifest_idx" ON "data_subject_request_backup_review" USING btree ("manifest_digest");--> statement-breakpoint
CREATE INDEX "data_subject_request_approval_scope_idx" ON "data_subject_request_approval" USING btree ("scope","version","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_subject_request_event_idempotency_idx" ON "data_subject_request_event" USING btree ("request_id","idempotency_key") WHERE "data_subject_request_event"."idempotency_key" is not null;