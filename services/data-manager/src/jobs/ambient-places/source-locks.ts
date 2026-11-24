import { DATA_ADVISORY_LOCKS } from "@openmapx/core/data-manager-sdk";
import { itemAt } from "@openmapx/core/item-at";
import type postgres from "postgres";
import { AmbientPublicationBusyError } from "./schema.js";

/** Prevent schema replacement between keyset batches without holding country data in memory. */
export async function lockAmbientCountrySources(tx: postgres.TransactionSql): Promise<void> {
  for (const pair of [DATA_ADVISORY_LOCKS.searchIndex, DATA_ADVISORY_LOCKS.overture]) {
    const row = itemAt(
      await tx.unsafe<{ locked: boolean }[]>(
        `SELECT pg_try_advisory_xact_lock_shared($1::INT,$2::INT) AS locked`,
        [...pair],
      ),
      0,
      "row from the ambient source lock query",
    );
    if (!row.locked)
      throw new AmbientPublicationBusyError(
        "Germany source preparation is running; retry after OSM and Overture workflows complete",
      );
  }
}

/** The published source tables a nearby-places build reads, as the planet signature pins them. */
const SOURCE_TABLES = [
  "osm_search.places",
  "overture_places.places",
  "overture_places.poi_conflation_link",
  "overture_places.osm_pois",
] as const;

/**
 * The source tables' OIDs as the build's transaction snapshot sees them, or
 * as the latest catalog resolves their names. A source publication swaps
 * new tables in under the live names without waiting for a regional build,
 * and every later statement resolves the names afresh, so the build would
 * read the new tables under its snapshot from then on.
 */
async function sourceTables(
  tx: postgres.TransactionSql,
  view: "snapshot" | "latest",
): Promise<string> {
  const oid =
    view === "latest"
      ? `to_regclass(t.relation)::OID`
      : `(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=split_part(t.relation,'.',1) AND c.relname=split_part(t.relation,'.',2))`;
  const row = itemAt(
    await tx.unsafe<{ tables: string }[]>(
      `SELECT string_agg(coalesce(${oid}::TEXT,'-'),',' ORDER BY t.ord) AS tables FROM unnest($1::TEXT[]) WITH ORDINALITY AS t(relation,ord)`,
      [[...SOURCE_TABLES]],
    ),
    0,
    "row from the ambient source table query",
  );
  return row.tables;
}

/**
 * Records which source tables a regional build reads. Its transaction's
 * snapshot fixes them, so a publication that commits even before this
 * statement is caught by `assertAmbientSourcesUnchanged`.
 */
export function captureAmbientSources(tx: postgres.TransactionSql): Promise<string> {
  return sourceTables(tx, "snapshot");
}

/**
 * Refuses to publish when a source data set was republished while the build
 * read it: some of its statements may then have read the old tables and some
 * the new ones. Throwing rolls the build back; the last good generation stays
 * live.
 */
export async function assertAmbientSourcesUnchanged(
  tx: postgres.TransactionSql,
  captured: string,
): Promise<void> {
  if ((await sourceTables(tx, "latest")) !== captured)
    throw new Error(
      "A source data set was republished during the nearby-places build; nothing was published and the last good generation stays live. Build again",
    );
}
