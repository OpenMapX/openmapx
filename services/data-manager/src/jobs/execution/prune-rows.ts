import type postgres from "postgres";

/** Removes the finished job rows of executions whose control records the prune removes. */
export async function removePrunedDataRows(
  sql: postgres.Sql,
  operationKeys: readonly string[],
): Promise<void> {
  await sql`DELETE FROM data_manager.jobs WHERE execution_version=2 AND finished_at IS NOT NULL AND operation_key = ANY(${[...operationKeys]})`;
}
