/** Fixed read-only inventory. Never select or export representative SQL text. */
export interface DiagnosticSql {
  unsafe(query: string): PromiseLike<Record<string, unknown>[]>;
}
export interface StatementMetrics {
  queryId: string;
  calls?: string;
  totalExecMs?: number;
  minExecMs?: number;
  maxExecMs?: number;
  meanExecMs?: number;
  rows?: string;
  sharedHitBlocks?: string;
  sharedReadBlocks?: string;
  tempReadBlocks?: string;
  tempWrittenBlocks?: string;
  walBytes?: string;
  statsSince?: string;
}
const counters = {
  calls: "calls",
  rows: "rows",
  shared_blks_hit: "sharedHitBlocks",
  shared_blks_read: "sharedReadBlocks",
  temp_blks_read: "tempReadBlocks",
  temp_blks_written: "tempWrittenBlocks",
  wal_bytes: "walBytes",
} as const;
const durations = {
  total_exec_time: "totalExecMs",
  min_exec_time: "minExecMs",
  max_exec_time: "maxExecMs",
  mean_exec_time: "meanExecMs",
} as const;
export function decimalCounter(value: unknown, signed = false): string {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("Invalid diagnostic counter");
  const text = String(value);
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(text)) throw new Error("Invalid diagnostic counter");
  return BigInt(text).toString();
}
function finite(value: unknown): number {
  if (value === null || value === undefined || value === "")
    throw new Error("Invalid diagnostic measurement");
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("Invalid diagnostic measurement");
  return number;
}
function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid diagnostic timestamp");
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))
    return value;
  return date.toISOString();
}
export function projectStatements(rows: Record<string, unknown>[]): StatementMetrics[] {
  return rows.slice(0, 50).map((row) => {
    const result: StatementMetrics = { queryId: decimalCounter(row.queryid, true) };
    for (const [source, target] of Object.entries(counters) as Array<
      [string, (typeof counters)[keyof typeof counters]]
    >) {
      if (row[source] !== undefined) result[target] = decimalCounter(row[source]);
    }
    for (const [source, target] of Object.entries(durations)) {
      if (row[source] !== undefined) result[target] = finite(row[source]);
    }
    const since = timestamp(row.stats_since);
    if (since) result.statsSince = since;
    return result;
  });
}
export interface DiagnosticSnapshot {
  schemaVersion: 1;
  observedAt: string;
  serverVersionNum: number;
  statsReset: string | null;
  statementCount: string;
  deallocations: string;
  settings: Record<string, { value: string; unit: string | null }>;
  database: Record<string, string>;
  locks: { granted: string; waiting: string };
  statements: StatementMetrics[];
}
export async function collectDiagnostics(sql: DiagnosticSql): Promise<DiagnosticSnapshot> {
  try {
    const [status] = await sql.unsafe(`SELECT current_setting('server_version_num') AS version,
      current_setting('shared_preload_libraries') AS preload,
      current_setting('pg_stat_statements.track', true) AS tracking,
      current_setting('compute_query_id') AS query_ids,
      current_setting('pg_stat_statements.track_utility', true) AS utility,
      EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed`);
    const version = Number(status?.version);
    if (
      !Number.isInteger(version) ||
      status?.installed !== true ||
      status.tracking !== "top" ||
      !["auto", "on"].includes(String(status.query_ids)) ||
      status.utility !== "off" ||
      !String(status.preload)
        .split(",")
        .map((s) => s.trim())
        .includes("pg_stat_statements") ||
      version < 180000 ||
      version >= 190000
    )
      throw new Error("Unavailable");
    const settings = await sql.unsafe(`SELECT name, setting, unit FROM pg_settings
      WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','max_connections',
      'max_parallel_workers','max_parallel_workers_per_gather','autovacuum_max_workers',
      'autovacuum_work_mem','wal_buffers','max_wal_size','checkpoint_timeout') ORDER BY name`);
    const [database] = await sql.unsafe(`SELECT xact_commit::text, xact_rollback::text,
      blks_read::text, blks_hit::text, temp_files::text, temp_bytes::text,
      deadlocks::text FROM pg_stat_database WHERE datid = (SELECT oid FROM pg_database WHERE datname=current_database())`);
    const [locks] = await sql.unsafe(`SELECT count(*) FILTER (WHERE granted)::text AS granted,
      count(*) FILTER (WHERE NOT granted)::text AS waiting FROM pg_locks
      WHERE database IS NULL OR database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
    const statements = await sql.unsafe(`SELECT queryid::text, calls::text, total_exec_time,
      min_exec_time, max_exec_time, mean_exec_time, rows::text, shared_blks_hit::text,
      shared_blks_read::text, temp_blks_read::text, temp_blks_written::text,
      wal_bytes::text, to_char(stats_since AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stats_since, count(*) OVER()::text AS total_entries FROM pg_stat_statements
      WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
      ORDER BY total_exec_time DESC, queryid LIMIT 50`);
    const [info] = await sql.unsafe(
      `SELECT to_char(stats_reset AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stats_reset, dealloc::text FROM pg_stat_statements_info`,
    );
    return {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      serverVersionNum: version,
      statsReset: timestamp(info?.stats_reset),
      statementCount: decimalCounter(statements[0]?.total_entries ?? "0"),
      deallocations: decimalCounter(info?.dealloc),
      settings: Object.fromEntries(
        settings.map((row) => {
          if (
            ![
              "shared_buffers",
              "work_mem",
              "maintenance_work_mem",
              "max_connections",
              "max_parallel_workers",
              "max_parallel_workers_per_gather",
              "autovacuum_max_workers",
              "autovacuum_work_mem",
              "wal_buffers",
              "max_wal_size",
              "checkpoint_timeout",
            ].includes(String(row.name))
          )
            throw new Error("Invalid setting");
          if (!/^-?\d+(\.\d+)?$/.test(String(row.setting))) throw new Error("Invalid setting");
          if (row.unit !== null && !/^[a-zA-Z0-9]+$/.test(String(row.unit)))
            throw new Error("Invalid unit");
          return [
            String(row.name),
            { value: String(row.setting), unit: row.unit === null ? null : String(row.unit) },
          ];
        }),
      ),
      database: Object.fromEntries(
        [
          "xact_commit",
          "xact_rollback",
          "blks_read",
          "blks_hit",
          "temp_files",
          "temp_bytes",
          "deadlocks",
        ].map((key) => [key, decimalCounter(database?.[key])]),
      ),
      locks: { granted: decimalCounter(locks?.granted), waiting: decimalCounter(locks?.waiting) },
      statements: projectStatements(statements),
    };
  } catch {
    throw new Error(
      "PostgreSQL diagnostics unavailable: use PostgreSQL 18, enable PG_STAT_STATEMENTS, restart, and verify extension access.",
    );
  }
}
