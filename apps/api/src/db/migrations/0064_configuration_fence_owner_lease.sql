-- Fences name the agent's lease now; rows bound to the old signed certificates cannot be kept.
DELETE FROM "data_manager"."configuration_fence";--> statement-breakpoint
ALTER TABLE "data_manager"."configuration_fence" ADD COLUMN "owner_lease_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "data_manager"."configuration_fence" DROP COLUMN "owner_certificate_digest";