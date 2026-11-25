import type postgres from "postgres";
import type { DataExecutionRecord, DataExecutionStore } from "../../src/jobs/execution/store.js";

/**
 * Every data job admitted at or after `since`, finished or not. Suites share
 * the job table, so each finds and removes its own rows by admission time.
 */
export async function dataJobsSince(
  sql: postgres.Sql,
  store: Pick<DataExecutionStore, "inspect">,
  since: number,
): Promise<DataExecutionRecord[]> {
  const rows = await sql<
    { id: string }[]
  >`SELECT id FROM data_manager.job WHERE admitted_at >= ${new Date(since).toISOString()}::text::timestamptz ORDER BY admitted_at,id`;
  const records = await Promise.all(rows.map((row) => store.inspect(row.id)));
  return records.filter((record): record is DataExecutionRecord => record !== null);
}
