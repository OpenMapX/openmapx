--
-- Migrate credential keys from camelCase to region-first hyphenated format.
--
-- This is a one-time migration that updates vault rows in the `integration_secret`
-- table. The old key strings (configSchema property names) are renamed to the new
-- hyphenated format. The vault key is data, independent of code; the manifest and
-- env-var migrations (already deployed) do not affect this script's timing. Run this
-- once against production after images ship.
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
-- Copy this script to the production host (~/openmapx), then execute it via the
-- Docker-deployed postgis service:
--   docker compose -f infra/docker/docker-compose.generated.yml exec -T postgis \
--     psql -U postgres -d openmapx -f scripts/migrate-credential-keys.sql
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
