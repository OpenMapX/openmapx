import type postgres from "postgres";
import { OVERTURE_LOCK_KEY, OVERTURE_LOCK_NAMESPACE } from "../overture/operation-lock.js";
import {
  SEARCH_INDEX_LOCK_KEY,
  SEARCH_INDEX_LOCK_NAMESPACE,
} from "../search-index/operation-lock.js";
import { AmbientPublicationBusyError } from "./schema.js";

/** Prevent schema replacement between keyset batches without holding country data in memory. */
export async function lockAmbientCountrySources(tx: postgres.TransactionSql): Promise<void> {
  for (const [namespace, key] of [
    [SEARCH_INDEX_LOCK_NAMESPACE, SEARCH_INDEX_LOCK_KEY],
    [OVERTURE_LOCK_NAMESPACE, OVERTURE_LOCK_KEY],
  ]) {
    const [row] = await tx.unsafe<{ locked: boolean }[]>(
      `SELECT pg_try_advisory_xact_lock_shared($1::INT,$2::INT) AS locked`,
      [namespace, key],
    );
    if (!row.locked)
      throw new AmbientPublicationBusyError(
        "Germany source preparation is running; retry after OSM and Overture workflows complete",
      );
  }
}
