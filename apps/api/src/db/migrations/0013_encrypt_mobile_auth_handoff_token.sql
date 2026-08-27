-- Existing rows contain redeemable plaintext and expire within two minutes.
-- Invalidate those in-flight handoffs rather than copying plaintext into the
-- new envelope or inventing a deployment-time key inside PostgreSQL.
TRUNCATE TABLE "mobile_auth_handoff";--> statement-breakpoint
ALTER TABLE "mobile_auth_handoff" ADD COLUMN "token_ciphertext" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mobile_auth_handoff" ADD COLUMN "token_iv" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mobile_auth_handoff" ADD COLUMN "token_tag" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mobile_auth_handoff" ADD COLUMN "token_key_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "mobile_auth_handoff" DROP COLUMN "one_time_token";
