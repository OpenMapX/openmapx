import type postgres from "postgres";

/** Removes the data-manager's rows for executions whose control records the
 * prune removes: their finished job rows and settled configuration fences. */
export async function removePrunedDataRows(
  sql: postgres.Sql,
  operationKeys: readonly string[],
): Promise<void> {
  const keys = [...operationKeys];
  await sql`DELETE FROM data_manager.configuration_fence WHERE operation_key = ANY(${keys}) AND state='settled'`;
  await sql`DELETE FROM data_manager.jobs WHERE execution_version=2 AND finished_at IS NOT NULL AND operation_key = ANY(${keys})`;
}
