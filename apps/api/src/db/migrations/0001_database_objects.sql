-- Database objects drizzle-kit cannot generate: roles and grants, the account
-- role CHECK on Better Auth's "user" table, the last-administrator invariant
-- and the account erasure trigger. Everything else is declared in the schema
-- code.

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
-- Tables the API role creates in `data_manager` after this migration get the
-- same grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA "data_manager" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openmapx_data_manager;--> statement-breakpoint
-- Data-manager waits at startup until the migrations its build expects are
-- applied; it reads the migration history for that and nothing else there.
GRANT USAGE ON SCHEMA "drizzle" TO openmapx_data_manager;--> statement-breakpoint
GRANT SELECT ON "drizzle"."__drizzle_migrations" TO openmapx_data_manager;--> statement-breakpoint
-- PostgreSQL 15 and later no longer let every role create objects in
-- `public`; state it, since data-manager must never place tables beside the
-- API's. Data-manager finds PostGIS in the `extensions` schema and has no
-- privilege on any API table in `public`.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint

-- Better Auth generates the "user" table and cannot declare a CHECK on it.
ALTER TABLE "user" ADD CONSTRAINT user_role_check CHECK (role IS NULL OR role IN ('user','admin'));--> statement-breakpoint

-- The data_manager schema code lives in a package that cannot see the API's
-- "user" table, so drizzle-kit cannot generate this foreign key. Deleting an
-- account clears it from the jobs the API started for it.
ALTER TABLE "data_manager"."job" ADD CONSTRAINT job_triggered_by_user_id_fkey FOREIGN KEY ("triggered_by_user_id") REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint

-- At least one active administrator always remains. The guard row counts the
-- active administrators; the trigger keeps it in step with every insert and
-- delete on "user" and every change of role or ban, and refuses the change
-- that would bring it to zero. The pinned search path finds the guard table
-- whatever the calling session's search path is.
INSERT INTO account_admin_guard(id,active_count) SELECT 1,count(*)::integer FROM "user" WHERE role='admin' AND banned IS NOT TRUE;--> statement-breakpoint
CREATE FUNCTION openmapx_preserve_admin_capacity() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
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
CREATE TRIGGER openmapx_admin_capacity BEFORE INSERT OR UPDATE OF role,banned OR DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION openmapx_preserve_admin_capacity();--> statement-breakpoint

-- Deleting an account clears what still names it and no foreign key reaches,
-- on every delete path: Better Auth's, the CLI's restore replay and plain SQL.
-- It runs with the rights of the deleting role (the API's, which owns these
-- tables). Offline-package rows name the account by a keyed hash only the API
-- can compute; its delete hook removes them. TRUNCATE "user" fires no row
-- trigger and skips all of this.
CREATE FUNCTION openmapx_erase_user_residue() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  -- NULL for an empty value, so a substring test can never match every row.
  erased_id text := nullif(OLD.id, '');
  erased_email text := nullif(lower(OLD.email), '');
  -- The address as a whole word: no address character may come directly
  -- before it, and neither a further label nor a hostname character after
  -- it, so deleting bob@example.com leaves alice.bob@example.com and
  -- bob@example.com.evil alone. Matched case-insensitively with ~*.
  erased_email_re text := CASE WHEN erased_email IS NOT NULL THEN
    '(?<![[:alnum:].!#$%&''*+/=?^_`{|}~-])'
    || regexp_replace(erased_email, '([^[:alnum:]@_-])', '\\\1', 'g')
    || '(?![[:alnum:]-]|\.[[:alnum:]])' END;
  -- Better Auth's emailed code for a change of address names the account,
  -- not its current address.
  erased_change_prefix text := 'change-email-otp-' || erased_id || ':';
BEGIN
  -- Privacy cases keep their history and record that the account is gone.
  UPDATE data_subject_request
  SET account_state = 'deleted', version = version + 1, updated_at = now()
  WHERE user_id = OLD.id AND account_state <> 'deleted';
  -- Better Auth's pending challenges for the account or its email. Its
  -- emailed codes are stored as `<type>-otp-<address>` with the address in
  -- lower case, and as `change-email-otp-<account id>:<new address>` for a
  -- change of address. Plain comparisons, not patterns, so no character of
  -- the address or the id can widen the match.
  DELETE FROM verification
  WHERE value = OLD.id
     OR lower(identifier) = erased_email
     OR lower(identifier) = lower('change-email:' || OLD.id || ':' || OLD.email)
     OR lower(identifier) IN ('sign-in-otp-' || erased_email,
                              'email-verification-otp-' || erased_email,
                              'forget-password-otp-' || erased_email,
                              'change-email-otp-' || erased_email)
     OR (left(identifier, length(erased_change_prefix)) = erased_change_prefix
         AND strpos(substr(identifier, length(erased_change_prefix) + 1), ':') = 0);
  -- Audit rows stay as the record of what happened, without the person.
  UPDATE admin_audit_log SET actor_user_id = NULL, ip_address = NULL, user_agent = NULL
  WHERE actor_user_id = OLD.id;
  UPDATE admin_audit_log SET target_id = NULL
  WHERE target_type = 'user' AND target_id = OLD.id;
  -- In jsonb the string values are tested too: in the text form an escape
  -- such as \n would stand directly before the address. The substring test
  -- first keeps the regular expressions off rows that cannot match.
  UPDATE admin_audit_log SET details = NULL
  WHERE position(erased_id in details::text) > 0
     OR (position(erased_email in lower(details::text)) > 0
         AND (details::text ~* erased_email_re
              OR EXISTS (SELECT FROM jsonb_path_query(details, 'strict $.**') AS item(value)
                         WHERE jsonb_typeof(item.value) = 'string'
                           AND item.value #>> '{}' ~* erased_email_re)));
  DELETE FROM app_log
  WHERE position(erased_id in message) > 0
     OR position(erased_id in metadata::text) > 0
     OR (position(erased_email in lower(message)) > 0 AND message ~* erased_email_re)
     OR (position(erased_email in lower(metadata::text)) > 0
         AND (metadata::text ~* erased_email_re
              OR EXISTS (SELECT FROM jsonb_path_query(metadata, 'strict $.**') AS item(value)
                         WHERE jsonb_typeof(item.value) = 'string'
                           AND item.value #>> '{}' ~* erased_email_re)));
  -- A pending administrator confirmation of an action on this account.
  DELETE FROM admin_action_reauthentication
  WHERE purpose LIKE 'user.%' AND target_id = OLD.id;
  -- An impersonation session must not outlive the administrator who started
  -- it as an ordinary-looking session of the impersonated account.
  DELETE FROM session WHERE impersonated_by = OLD.id;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER openmapx_erase_user_residue BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION openmapx_erase_user_residue();
