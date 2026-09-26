DROP INDEX "account_issuer_accountId_uidx";--> statement-breakpoint
DROP INDEX "verification_expiresAt_idx";--> statement-breakpoint
ALTER TABLE "account" DROP COLUMN "issuer";