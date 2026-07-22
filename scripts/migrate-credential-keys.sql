--
-- Migrate credential keys from camelCase to region-first hyphenated format.
--
-- This is a one-time migration that renames vault rows in the `integration_secret`
-- table from the old configSchema property names to the new hyphenated ones.
--
-- TIMING IS CRITICAL — vault rows are NOT independent of code. `apps/api` applies a
-- vault secret to an integration only when its key is present in that integration's
-- manifest `configSchema` (see the `knownKeys.has(key)` filter in
-- `apps/api/src/integration-config.ts`). Renaming these rows while the OLD manifest
-- is still live silently drops the renamed credentials — the running code no longer
-- recognizes the new key name. So the new images (which ship the new manifests)
-- MUST already be running in production before this script executes.
--
-- A restart of `app-api` is REQUIRED after running this script. Integrations
-- capture their credentials once at `setup(ctx)` (see `integrations/*/index.ts`),
-- so renamed vault rows do not reach a provider until the integration reloads.
--
-- Correct end-to-end order on prod:
--   1. Push to main; let CI build the `app-api`, `app-web`, `data-manager` images.
--   2. On the prod host, `git pull` — the compose-render step below reads
--      `services/data-manager/service.json` from the checkout, not from an image.
--   3. Rename the `INTEGRATION_*` vars in the prod `infra/docker/.env` to their new
--      derived names BEFORE recreating containers (`env_file` is read at
--      container-create time, not on every start). Also add entries for the
--      parking/webcam credentials that were previously bare env names, now under
--      their derived `INTEGRATION_PARKING_*` / `INTEGRATION_WEBCAM_*` names.
--   4. `pnpm openmapx compose render` — MANDATORY. Skipping this leaves
--      data-manager on the deleted curated passthrough with no `env_file`, so
--      parking ingest loses its credentials regardless of step 3.
--   5. `docker compose up -d` — a recreate, not a restart, so the new images and
--      the rendered compose file actually take effect.
--   6. Run this script.
--   7. Restart `app-api` so the vault-sourced credentials reach `setup(ctx)`.
--   8. Run the orphan-row SELECT below and decide whether to delete leftovers.
--
-- Expected window: between step 5 and step 7, credentials that come only from the
-- vault (no `.env` override) resolve to `undefined`, so the affected integrations'
-- health probes may go red. That is expected mid-deploy behavior, not a failed
-- deploy — it clears once `app-api` restarts in step 7.
--
-- Rollback: rolling the images back after step 6 leaves the vault on the NEW keys
-- while the rolled-back code expects the OLD keys — every migrated credential goes
-- silently missing. Rolling back requires also running the inverse `UPDATE`s (new
-- key -> old key) against the vault before reverting `app-api`.
--
-- Idempotent and collision-guarded: if a row with the new key already exists for that
-- integration (e.g. a re-entered credential post-deploy), the UPDATE skips rather than
-- violating the unique constraint. This leaves the old-key row as an orphan — a
-- still-encrypted credential row that no code path will read again. After running this
-- migration, check for leftover orphan rows and decide whether to delete them:
--
--   SELECT integration_id, key FROM integration_secret WHERE key IN (
--     'openChargeMapApiKey','afdcApiKey','nobilApiKey','tankerkoenigApiKey',
--     'dbBahnParkClientId','dbBahnParkApiKey','utmcUsername','utmcPassword','nswTransportApiKey',
--     'nrwMobidromClientId','nrwMobidromClientSecret','dbClientId','dbApiKey',
--     'windyApiKey','npsApiKey','dotGaApiKey','dotFlApiKey','dotAzApiKey','dotIdApiKey',
--     'dotUtApiKey','dotLaApiKey','dotPaApiKey','dotScApiKey','dotMaApiKey'
--   );
--
-- Optional: preview which rows will be touched before running the migration. Run each
-- old-key SELECT against the openmapx database to see which integration_secret rows
-- exist, e.g.: SELECT * FROM integration_secret WHERE key = 'openChargeMapApiKey';
--
-- Command to run against production:
-- Copy this script to the production host (~/openmapx), then pipe it into the
-- Docker-deployed postgis service. The redirect is evaluated by the HOST shell and
-- the file is fed over stdin — the postgis container has no bind mounts, so a
-- container-side `-f <path>` would not find this file:
--   docker compose -f infra/docker/docker-compose.generated.yml exec -T postgis \
--     psql -U postgres -d openmapx < scripts/migrate-credential-keys.sql
--

BEGIN TRANSACTION;

-- EV Charging
UPDATE integration_secret SET key = 'ocm-api-key'
WHERE integration_id = 'ev-charging' AND key = 'openChargeMapApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'ev-charging' AND key = 'ocm-api-key'
);

UPDATE integration_secret SET key = 'us-afdc-api-key'
WHERE integration_id = 'ev-charging' AND key = 'afdcApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'ev-charging' AND key = 'us-afdc-api-key'
);

UPDATE integration_secret SET key = 'no-nobil-api-key'
WHERE integration_id = 'ev-charging' AND key = 'nobilApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'ev-charging' AND key = 'no-nobil-api-key'
);

-- Fuel
UPDATE integration_secret SET key = 'de-tankerkoenig-api-key'
WHERE integration_id = 'fuel' AND key = 'tankerkoenigApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'fuel' AND key = 'de-tankerkoenig-api-key'
);

-- Parking
UPDATE integration_secret SET key = 'de-db-bahnpark-client-id'
WHERE integration_id = 'parking' AND key = 'dbBahnParkClientId'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'parking' AND key = 'de-db-bahnpark-client-id'
);

UPDATE integration_secret SET key = 'de-db-bahnpark-api-key'
WHERE integration_id = 'parking' AND key = 'dbBahnParkApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'parking' AND key = 'de-db-bahnpark-api-key'
);

UPDATE integration_secret SET key = 'gb-eng-utmc-username'
WHERE integration_id = 'parking' AND key = 'utmcUsername'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'parking' AND key = 'gb-eng-utmc-username'
);

UPDATE integration_secret SET key = 'gb-eng-utmc-password'
WHERE integration_id = 'parking' AND key = 'utmcPassword'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'parking' AND key = 'gb-eng-utmc-password'
);

UPDATE integration_secret SET key = 'au-nsw-api-key'
WHERE integration_id = 'parking' AND key = 'nswTransportApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'parking' AND key = 'au-nsw-api-key'
);

-- Scooter Sharing
UPDATE integration_secret SET key = 'de-nw-mobidrom-scooter-client-id'
WHERE integration_id = 'scooter-sharing' AND key = 'nrwMobidromClientId'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'scooter-sharing' AND key = 'de-nw-mobidrom-scooter-client-id'
);

UPDATE integration_secret SET key = 'de-nw-mobidrom-scooter-client-secret'
WHERE integration_id = 'scooter-sharing' AND key = 'nrwMobidromClientSecret'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'scooter-sharing' AND key = 'de-nw-mobidrom-scooter-client-secret'
);

-- Bike Sharing
UPDATE integration_secret SET key = 'db-bike-client-id'
WHERE integration_id = 'bike-sharing' AND key = 'dbClientId'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'bike-sharing' AND key = 'db-bike-client-id'
);

UPDATE integration_secret SET key = 'db-bike-api-key'
WHERE integration_id = 'bike-sharing' AND key = 'dbApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'bike-sharing' AND key = 'db-bike-api-key'
);

-- Webcam
UPDATE integration_secret SET key = 'windy-api-key'
WHERE integration_id = 'webcam' AND key = 'windyApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'windy-api-key'
);

UPDATE integration_secret SET key = 'nps-api-key'
WHERE integration_id = 'webcam' AND key = 'npsApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'nps-api-key'
);

UPDATE integration_secret SET key = 'dot-ga-api-key'
WHERE integration_id = 'webcam' AND key = 'dotGaApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'dot-ga-api-key'
);

UPDATE integration_secret SET key = 'dot-fl-api-key'
WHERE integration_id = 'webcam' AND key = 'dotFlApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'dot-fl-api-key'
);

UPDATE integration_secret SET key = 'dot-az-api-key'
WHERE integration_id = 'webcam' AND key = 'dotAzApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'dot-az-api-key'
);

UPDATE integration_secret SET key = 'dot-id-api-key'
WHERE integration_id = 'webcam' AND key = 'dotIdApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'dot-id-api-key'
);

UPDATE integration_secret SET key = 'dot-ut-api-key'
WHERE integration_id = 'webcam' AND key = 'dotUtApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'dot-ut-api-key'
);

UPDATE integration_secret SET key = 'dot-la-api-key'
WHERE integration_id = 'webcam' AND key = 'dotLaApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'dot-la-api-key'
);

UPDATE integration_secret SET key = 'dot-pa-api-key'
WHERE integration_id = 'webcam' AND key = 'dotPaApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'dot-pa-api-key'
);

UPDATE integration_secret SET key = 'dot-sc-api-key'
WHERE integration_id = 'webcam' AND key = 'dotScApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'dot-sc-api-key'
);

UPDATE integration_secret SET key = 'dot-ma-api-key'
WHERE integration_id = 'webcam' AND key = 'dotMaApiKey'
AND NOT EXISTS (
  SELECT 1 FROM integration_secret
  WHERE integration_id = 'webcam' AND key = 'dot-ma-api-key'
);

COMMIT;
