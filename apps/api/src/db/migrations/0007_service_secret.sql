CREATE TABLE "service_secret" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "serviceSecret_serviceId_key_unq" UNIQUE("service_id","key")
);
--> statement-breakpoint
ALTER TABLE "service_secret" ADD CONSTRAINT "service_secret_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "serviceSecret_serviceId_idx" ON "service_secret" USING btree ("service_id");