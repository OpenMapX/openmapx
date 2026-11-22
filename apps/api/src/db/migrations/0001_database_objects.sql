-- Database objects drizzle-kit cannot generate: roles and grants, the account
-- role CHECK on Better Auth's "user" table, and the last-administrator
-- invariant. Everything else is declared in the schema code.

-- Data-manager connects as its own role and may change only its own tables.
-- PostGIS creates the role on every start; a database without that entrypoint
-- (development, tests) gets a role that cannot log in, so the grants below
-- always apply. Where the role is missing in a deployment, the API role cannot
-- create it and this migration fails instead of skipping the grants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openmapx_data_manager') THEN
    CREATE ROLE openmapx_data_manager NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA "data_manager" TO openmapx_data_manager;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "data_manager" TO openmapx_data_manager;--> statement-breakpoint
-- Tables later migrations add to `data_manager` follow the same grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA "data_manager" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openmapx_data_manager;--> statement-breakpoint
-- PostgreSQL 15 and later no longer let every role create objects in
-- `public`; state it, since data-manager must never place tables beside the
-- API's. Data-manager keeps the default use of `public` for PostGIS types and
-- functions, and has no privilege on any API table there.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint

-- Better Auth generates the "user" table and cannot declare a CHECK on it.
ALTER TABLE "user" ADD CONSTRAINT openmapx_canonical_account_role CHECK (role IS NULL OR role IN ('user','admin'));--> statement-breakpoint

-- At least one active administrator always remains. The guard row counts the
-- active administrators; the trigger keeps it in step with every change to
-- "user" and refuses the change that would bring it to zero.
INSERT INTO account_admin_guard(id,active_count) SELECT 1,count(*)::integer FROM "user" WHERE role='admin' AND banned IS NOT TRUE;--> statement-breakpoint
CREATE FUNCTION openmapx_preserve_admin_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_active integer:=0; new_active integer:=0; delta integer;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_active:=CASE WHEN OLD.role='admin' AND OLD.banned IS NOT TRUE THEN 1 ELSE 0 END; END IF;
 IF TG_OP <> 'DELETE' THEN new_active:=CASE WHEN NEW.role='admin' AND NEW.banned IS NOT TRUE THEN 1 ELSE 0 END; END IF;
 delta:=new_active-old_active;
 IF delta <> 0 THEN
  UPDATE account_admin_guard SET active_count=active_count+delta WHERE id=1 AND (delta>0 OR active_count+delta>0);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',CONSTRAINT='LAST_ADMIN_REQUIRED',MESSAGE='LAST_ADMIN_REQUIRED'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER openmapx_admin_capacity BEFORE INSERT OR UPDATE OF role,banned OR DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION openmapx_preserve_admin_capacity();
