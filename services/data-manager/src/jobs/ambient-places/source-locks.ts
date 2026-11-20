import { DATA_ADVISORY_LOCKS } from "@openmapx/core/data-manager-sdk";
import type postgres from "postgres";
import { requiredRow } from "../../db/required-row.js";
import { AmbientPublicationBusyError } from "./schema.js";

/** Prevent schema replacement between keyset batches without holding country data in memory. */
export async function lockAmbientCountrySources(tx: postgres.TransactionSql): Promise<void> {
  for (const pair of [DATA_ADVISORY_LOCKS.searchIndex, DATA_ADVISORY_LOCKS.overture]) {
    const row = requiredRow(
      await tx.unsafe<{ locked: boolean }[]>(
        `SELECT pg_try_advisory_xact_lock_shared($1::INT,$2::INT) AS locked`,
        [...pair],
      ),
      "Ambient source lock",
    );
    if (!row.locked)
      throw new AmbientPublicationBusyError(
        "Germany source preparation is running; retry after OSM and Overture workflows complete",
      );
  }
}
