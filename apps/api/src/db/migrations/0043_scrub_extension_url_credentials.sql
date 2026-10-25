-- Historical extension state may contain acquisition URLs accepted before
-- extension locators became credential-free. Replace unsafe JSON string values
-- with null so no later recovery path can accidentally reuse a partial URL.
CREATE OR REPLACE FUNCTION public.openmapx_unsafe_extension_locator_0043(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* '^[[:cntrl:][:space:]]*https?:[/\\]*[^/?#\\]*@'
      OR regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* '^[[:cntrl:][:space:]]*(git|ssh):[/\\]*[^/?#]*@'
      OR regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* '^[[:cntrl:][:space:]]*(https?|git|ssh):[^?#]*[?][^#]+'
      OR regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* '^[[:cntrl:][:space:]]*(https?|git|ssh):[^#]*#.+$'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.openmapx_extension_locators_0043(value jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN ARRAY(
      SELECT DISTINCT locator
        FROM jsonb_each(value) AS entry(key, item)
        CROSS JOIN LATERAL unnest(
          CASE
            WHEN jsonb_typeof(item) = 'string'
              AND key IN ('artifact', 'repo', 'repository', 'sourceUrl', 'source_url', 'url', 'manifest')
              AND public.openmapx_unsafe_extension_locator_0043(item #>> '{}')
            THEN ARRAY[item #>> '{}']
            ELSE public.openmapx_extension_locators_0043(item)
          END
        ) AS found(locator)
       ORDER BY locator
    )::text[]
    WHEN 'array' THEN ARRAY(
      SELECT DISTINCT locator
        FROM jsonb_array_elements(value) AS entry(item)
        CROSS JOIN LATERAL unnest(public.openmapx_extension_locators_0043(item))
          AS found(locator)
       ORDER BY locator
    )::text[]
    ELSE ARRAY[]::text[]
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.openmapx_scrub_extension_manifest_json_0043(
  value jsonb,
  locators text[]
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN COALESCE(
      (SELECT jsonb_object_agg(
          key,
          CASE
            WHEN key IN ('homepage', 'icon', 'screenshots')
            THEN item
            WHEN jsonb_typeof(item) = 'string'
              AND key IN ('artifact', 'repo', 'repository', 'sourceUrl', 'source_url', 'url', 'manifest')
              AND public.openmapx_unsafe_extension_locator_0043(item #>> '{}')
            THEN 'null'::jsonb
            ELSE public.openmapx_scrub_extension_manifest_json_0043(item, locators)
          END
        )
         FROM jsonb_each(value) AS entry(key, item)),
      '{}'::jsonb
    )
    WHEN 'array' THEN COALESCE(
      (SELECT jsonb_agg(public.openmapx_scrub_extension_manifest_json_0043(item, locators) ORDER BY ordinal)
         FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(item, ordinal)),
      '[]'::jsonb
    )
    WHEN 'string' THEN CASE
      WHEN EXISTS (
        SELECT 1 FROM unnest(locators) AS unsafe(locator)
         WHERE strpos(value #>> '{}', locator) > 0
      )
      THEN 'null'::jsonb
      ELSE value
    END
    ELSE value
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.openmapx_scrub_extension_json_0043(
  value jsonb,
  locators text[]
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN COALESCE(
      (SELECT jsonb_object_agg(
          key,
          CASE
            WHEN key = 'manifest' AND jsonb_typeof(item) IN ('object', 'array')
            THEN public.openmapx_scrub_extension_manifest_json_0043(item, locators)
            WHEN jsonb_typeof(item) = 'string'
              AND key IN ('artifact', 'repo', 'repository', 'sourceUrl', 'source_url', 'url', 'manifest')
              AND public.openmapx_unsafe_extension_locator_0043(item #>> '{}')
            THEN 'null'::jsonb
            ELSE public.openmapx_scrub_extension_json_0043(item, locators)
          END
        )
         FROM jsonb_each(value) AS entry(key, item)),
      '{}'::jsonb
    )
    WHEN 'array' THEN COALESCE(
      (SELECT jsonb_agg(public.openmapx_scrub_extension_json_0043(item, locators) ORDER BY ordinal)
         FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(item, ordinal)),
      '[]'::jsonb
    )
    WHEN 'string' THEN CASE
      WHEN EXISTS (
        SELECT 1 FROM unnest(locators) AS unsafe(locator)
         WHERE strpos(value #>> '{}', locator) > 0
      )
      THEN 'null'::jsonb
      ELSE value
    END
    ELSE value
  END
$$;
--> statement-breakpoint
WITH candidates AS (
  SELECT id,
         array_cat(
           public.openmapx_extension_locators_0043(manifest),
           CASE
             WHEN public.openmapx_unsafe_extension_locator_0043(source_url)
             THEN ARRAY[source_url]
             ELSE ARRAY[]::text[]
           END
         ) AS locators
    FROM installed_extension
)
UPDATE installed_extension AS extension
SET manifest = public.openmapx_scrub_extension_manifest_json_0043(
  extension.manifest,
  candidates.locators
)
FROM candidates
WHERE extension.id = candidates.id
  AND extension.manifest IS NOT NULL
  AND extension.manifest IS DISTINCT FROM public.openmapx_scrub_extension_manifest_json_0043(
    extension.manifest,
    candidates.locators
  );
--> statement-breakpoint
UPDATE installed_extension
SET source_url = NULL
WHERE public.openmapx_unsafe_extension_locator_0043(source_url);
--> statement-breakpoint
UPDATE installed_integration
SET repository = 'redacted-extension-locator:' || id
WHERE managed_by_extension IS NOT NULL
  AND public.openmapx_unsafe_extension_locator_0043(repository);
--> statement-breakpoint
UPDATE service_repository
SET url = 'redacted-extension-locator:' || hash
WHERE public.openmapx_unsafe_extension_locator_0043(url);
--> statement-breakpoint
WITH candidates AS (
  SELECT id,
         array_cat(
           public.openmapx_extension_locators_0043(payload),
           public.openmapx_extension_locators_0043(result)
         ) AS locators
    FROM admin_job
   WHERE type = 'extension.install'
)
UPDATE admin_job_log AS log
SET line = 'Extension install output removed because it contained a legacy unsafe URL'
FROM candidates
WHERE log.job_id = candidates.id
  AND EXISTS (
    SELECT 1 FROM unnest(candidates.locators) AS unsafe(locator)
     WHERE strpos(log.line, locator) > 0
  );
--> statement-breakpoint
WITH candidates AS (
  SELECT id,
         array_cat(
           public.openmapx_extension_locators_0043(payload),
           public.openmapx_extension_locators_0043(result)
         ) AS locators
    FROM admin_job
   WHERE type = 'extension.install'
)
UPDATE admin_job AS job
SET payload = public.openmapx_scrub_extension_json_0043(job.payload, candidates.locators),
    result = public.openmapx_scrub_extension_json_0043(job.result, candidates.locators),
    error = CASE
      WHEN EXISTS (
        SELECT 1 FROM unnest(candidates.locators) AS unsafe(locator)
         WHERE strpos(job.error, locator) > 0
      )
      THEN 'Extension install output removed because it contained a legacy unsafe URL'
      ELSE job.error
    END
FROM candidates
WHERE job.id = candidates.id
  AND (
    job.payload IS DISTINCT FROM public.openmapx_scrub_extension_json_0043(
      job.payload,
      candidates.locators
    )
    OR job.result IS DISTINCT FROM public.openmapx_scrub_extension_json_0043(
      job.result,
      candidates.locators
    )
    OR EXISTS (
      SELECT 1 FROM unnest(candidates.locators) AS unsafe(locator)
       WHERE strpos(job.error, locator) > 0
    )
  );
--> statement-breakpoint
DROP FUNCTION public.openmapx_scrub_extension_json_0043(jsonb, text[]);
--> statement-breakpoint
DROP FUNCTION public.openmapx_scrub_extension_manifest_json_0043(jsonb, text[]);
--> statement-breakpoint
DROP FUNCTION public.openmapx_extension_locators_0043(jsonb);
--> statement-breakpoint
DROP FUNCTION public.openmapx_unsafe_extension_locator_0043(text);
