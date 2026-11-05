CREATE TABLE "integration_application_receipt" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"integration_id" text NOT NULL,
	"capability" text NOT NULL,
	"service_id" text,
	"candidate_id" uuid NOT NULL,
	"intent_digest" text NOT NULL,
	"saved_binding_revision" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_binding_revision" (
	"integration_id" text PRIMARY KEY NOT NULL,
	"version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_application_receipt" ADD CONSTRAINT "integration_application_receipt_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_application_target_time_idx" ON "integration_application_receipt" USING btree ("integration_id","created_at");--> statement-breakpoint
CREATE INDEX "integration_application_actor_idx" ON "integration_application_receipt" USING btree ("actor_id");