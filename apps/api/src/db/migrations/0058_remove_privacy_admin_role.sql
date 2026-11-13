-- Privacy casework now requires a full administrator. Former privacy
-- caseworkers become ordinary users before the role leaves the check.
UPDATE "user" SET role='user' WHERE role='privacy_admin';
--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT openmapx_canonical_account_role;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT openmapx_canonical_account_role CHECK (role IS NULL OR role IN ('user','admin'));
