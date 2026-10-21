ALTER TABLE "service_repository" ALTER COLUMN "last_sha" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "service_repository" ALTER COLUMN "managed_by_extension" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "service_repository" ADD COLUMN "last_transaction_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_repository" DROP COLUMN "display_name";--> statement-breakpoint
ALTER TABLE "service_repository" DROP COLUMN "last_fetched_at";--> statement-breakpoint
ALTER TABLE "service_repository" DROP COLUMN "auto_update";