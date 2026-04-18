CREATE TABLE "capability_binding" (
	"integration_id" text NOT NULL,
	"capability" text NOT NULL,
	"service_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "capability_binding_integration_id_capability_pk" PRIMARY KEY("integration_id","capability")
);
--> statement-breakpoint
CREATE INDEX "idx_capability_binding_service" ON "capability_binding" USING btree ("service_id");