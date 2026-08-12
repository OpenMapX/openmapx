-- Custom SQL migration file, put your code below! --

-- The knowledge-sunrise-sunset integration was renamed to knowledge-sun-time
-- when it gained the timezone lookup. Carry the operator's enabled/disabled
-- choice across so the rename does not silently reset it.
UPDATE "integration_config"
SET "integration_id" = 'knowledge-sun-time'
WHERE "integration_id" = 'knowledge-sunrise-sunset';