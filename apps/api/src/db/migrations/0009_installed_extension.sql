CREATE TABLE "installed_extension" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"source_url" text,
	"source_trust" text DEFAULT 'community' NOT NULL,
	"installed_version" text NOT NULL,
	"manifest" jsonb,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"installed_by" text
);
--> statement-breakpoint
CREATE TABLE "installed_extension_component" (
	"extension_id" text NOT NULL,
	"kind" text NOT NULL,
	"component_id" text NOT NULL,
	CONSTRAINT "installed_extension_component_extension_id_kind_component_id_pk" PRIMARY KEY("extension_id","kind","component_id")
);
--> statement-breakpoint
ALTER TABLE "installed_integration" ADD COLUMN "managed_by_extension" text;--> statement-breakpoint
ALTER TABLE "installed_extension" ADD CONSTRAINT "installed_extension_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installed_extension_component" ADD CONSTRAINT "installed_extension_component_extension_id_installed_extension_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."installed_extension"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installedExtension_sourceTrust_idx" ON "installed_extension" USING btree ("source_trust");--> statement-breakpoint
CREATE INDEX "installedExtensionComponent_componentId_idx" ON "installed_extension_component" USING btree ("component_id");