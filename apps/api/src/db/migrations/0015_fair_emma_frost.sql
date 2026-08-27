-- One installed component must belong to exactly one extension. Fail loudly and
-- name the conflicts rather than letting CREATE UNIQUE INDEX report an opaque
-- violation, and never pick a winner on the operator's behalf.
DO $$
DECLARE
  conflicts text;
BEGIN
  SELECT string_agg(format('%s:%s', kind, component_id), ', ' ORDER BY kind, component_id)
    INTO conflicts
  FROM (
    SELECT kind, component_id
    FROM installed_extension_component
    GROUP BY kind, component_id
    HAVING count(DISTINCT extension_id) > 1
  ) duplicates;

  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION 'Component ownership conflict: % claimed by more than one extension', conflicts
      USING HINT = 'Uninstall the extension that should not own each component, then re-run migrations. This migration will not choose a winner.';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "installedExtensionComponent_kind_componentId_key" ON "installed_extension_component" USING btree ("kind","component_id");