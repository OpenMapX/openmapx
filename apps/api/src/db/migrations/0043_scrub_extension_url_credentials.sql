-- Historical extension state may contain acquisition URLs accepted before
-- extension locators became credential-free. Replace unsafe JSON string values
-- with null so no later recovery path can accidentally reuse a partial URL.
CREATE OR REPLACE FUNCTION public.openmapx_unsafe_extension_locator_0043(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* 'https?:[/\\]*[^/?#\\]*@'
      OR regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* '(git|ssh):[/\\]*[^/?#]*@'
      OR regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* '(https?|git|ssh):[^[:space:]?#]*[?][^#[:space:]]+'
      OR regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* '(https?|git|ssh):[^[:space:]#]*#[^[:space:]]+'
      OR regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* '^[[:space:]]*(https?|git|ssh):[^?#]*[?][^#]+'
      OR regexp_replace(value, E'[\\t\\n\\r]', '', 'g')
           ~* '^[[:space:]]*(https?|git|ssh):[^#]*#.+$'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.openmapx_scrub_extension_json_0043(value jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN COALESCE(
      (SELECT jsonb_object_agg(key, public.openmapx_scrub_extension_json_0043(item))
         FROM jsonb_each(value) AS entry(key, item)),
      '{}'::jsonb
    )
    WHEN 'array' THEN COALESCE(
      (SELECT jsonb_agg(public.openmapx_scrub_extension_json_0043(item) ORDER BY ordinal)
         FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(item, ordinal)),
      '[]'::jsonb
    )
    WHEN 'string' THEN CASE
      WHEN public.openmapx_unsafe_extension_locator_0043(value #>> '{}')
      THEN 'null'::jsonb
      ELSE value
    END
    ELSE value
  END
$$;
--> statement-breakpoint
UPDATE installed_extension
SET source_url = NULL
WHERE public.openmapx_unsafe_extension_locator_0043(source_url);
--> statement-breakpoint
UPDATE installed_extension
SET manifest = public.openmapx_scrub_extension_json_0043(manifest)
WHERE manifest IS NOT NULL
  AND manifest IS DISTINCT FROM public.openmapx_scrub_extension_json_0043(manifest);
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
UPDATE admin_job
SET payload = public.openmapx_scrub_extension_json_0043(payload),
    result = public.openmapx_scrub_extension_json_0043(result),
    error = CASE
      WHEN public.openmapx_unsafe_extension_locator_0043(error)
      THEN 'Extension install output removed because it contained a legacy unsafe URL'
      ELSE error
    END
WHERE type = 'extension.install'
  AND (
    payload IS DISTINCT FROM public.openmapx_scrub_extension_json_0043(payload)
    OR result IS DISTINCT FROM public.openmapx_scrub_extension_json_0043(result)
    OR public.openmapx_unsafe_extension_locator_0043(error)
  );
--> statement-breakpoint
UPDATE admin_job_log AS log
SET line = 'Extension install output removed because it contained a legacy unsafe URL'
FROM admin_job AS job
WHERE log.job_id = job.id
  AND job.type = 'extension.install'
  AND public.openmapx_unsafe_extension_locator_0043(log.line);
--> statement-breakpoint
DROP FUNCTION public.openmapx_scrub_extension_json_0043(jsonb);
--> statement-breakpoint
DROP FUNCTION public.openmapx_unsafe_extension_locator_0043(text);
