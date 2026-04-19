CREATE TABLE "service_config" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "serviceConfig_serviceId_unq" UNIQUE("service_id")
);
--> statement-breakpoint
CREATE INDEX "serviceConfig_serviceId_idx" ON "service_config" USING btree ("service_id");