-- There are no deployed users. Discard development plaintext envelopes explicitly;
-- their wraps are removed by the existing cascading foreign key.
DELETE FROM "mangrove_keypair" WHERE "encryption_mode" = 'unencrypted';--> statement-breakpoint
ALTER TABLE "mangrove_keypair" ADD COLUMN "revision" text;--> statement-breakpoint
UPDATE "mangrove_keypair" SET "revision" = gen_random_uuid()::text;--> statement-breakpoint
ALTER TABLE "mangrove_keypair" ALTER COLUMN "revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mangrove_keypair" DROP COLUMN "encryption_mode";--> statement-breakpoint
ALTER TABLE "mangrove_keypair" DROP COLUMN "private_jwk";
