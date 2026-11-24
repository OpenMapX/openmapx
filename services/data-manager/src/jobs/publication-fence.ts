/** The table in every swapped data set's schema that publications lock. */
export const PUBLICATION_FENCE = "publication_fence";

/**
 * A table that only backups and publications touch: no reader queries it.
 * `pg_dump` takes ACCESS SHARE on every table it dumps when it starts and
 * keeps it to the end, so a publication that first locks the fence in ACCESS
 * EXCLUSIVE mode waits for a running backup instead of renaming tables under
 * it, and readers never queue behind that lock. A publication also replaces
 * the fence it locked. A backup that took its snapshot before the publication
 * but reaches the fence only after it then fails when it reads the dropped
 * fence's key and check instead of writing an archive that names renamed
 * objects. The primary key is what makes such a dump fail: `pg_dump` renders
 * the dropped fence's index-backed constraint by OID, which is a cache lookup
 * error. Keep it, even though no query uses it. Name lookups are left to the
 * caller, which validates `schema`.
 */
export function buildPublicationFenceDDL(schema: string): string {
  return `
    CREATE TABLE "${schema}".${PUBLICATION_FENCE} (
      singleton SMALLINT CONSTRAINT ${PUBLICATION_FENCE}_pkey PRIMARY KEY
        CONSTRAINT ${PUBLICATION_FENCE}_singleton_check CHECK (singleton = 1)
    );
  `;
}
