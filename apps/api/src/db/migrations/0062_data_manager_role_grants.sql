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
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
