CREATE TABLE "integration_config" (
	"id" text PRIMARY KEY NOT NULL,
	"integration_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integrationConfig_integrationId_unq" UNIQUE("integration_id")
);
--> statement-breakpoint
CREATE INDEX "integrationConfig_integrationId_idx" ON "integration_config" USING btree ("integration_id");