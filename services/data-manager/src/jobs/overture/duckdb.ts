import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envString } from "@openmapx/core/server-env";
import { type Options as ExecaOptions, type Result as ExecaResult, execa } from "execa";

/**
 * Replaces the password in any embedded Postgres connection string with `***`.
 * The Overture DuckDB scripts ATTACH the database via its connection string, so
 * a failing `duckdb -c` would otherwise echo `postgres://user:<password>@host`
 * into execa's error message (and from there into logs / NDJSON error events).
 */
export function redactConnectionString(text: string): string {
  return text.replace(/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s'"]*@/gi, "$1***@");
}

/** Quotes an arbitrary value as a DuckDB SQL string literal. */
export function duckDbSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Runs `duckdb` with the given args, rethrowing a redacted error on failure so
 * an embedded Postgres password never reaches logs. Pass-through `options` keep
 * each call site's stdio/format (e.g. `-csv`, `stdio: "pipe"` vs `"inherit"`).
 */
export async function runDuckDb(args: string[], options?: ExecaOptions): Promise<ExecaResult> {
  let scratch: string | undefined;
  try {
    const root = join(process.env.DATA_DIR ?? tmpdir(), "overture", "duckdb-tmp");
    await mkdir(root, { recursive: true });
    scratch = await mkdtemp(join(root, "run-"));
    return (await execa(
      "duckdb",
      ["-bail", "-cmd", duckDbResourceSql(process.env, scratch), ...args],
      options ?? {},
    )) as ExecaResult;
  } catch (err) {
    const e = err as { message?: string; stderr?: unknown; stdout?: unknown; exitCode?: number };
    const parts = [redactConnectionString(e.message ?? "duckdb command failed")];
    if (typeof e.stderr === "string" && e.stderr.trim()) {
      parts.push(redactConnectionString(e.stderr));
    }
    if (typeof e.stdout === "string" && e.stdout.trim()) {
      parts.push(redactConnectionString(e.stdout));
    }
    throw new Error(parts.join("\n"));
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Sends a DuckDB script over stdin rather than placing it in `argv`. This is
 * mandatory for scripts containing credentials: process command lines are
 * observable by other processes and often captured by supervisors. Child
 * output remains buffered so `runDuckDb` can redact it before an error leaves
 * this module.
 */
export async function runDuckDbScript(script: string, args: string[] = []): Promise<ExecaResult> {
  return runDuckDb(args, duckDbScriptProcessOptions(script));
}

export function duckDbScriptProcessOptions(
  script: string,
  environment: NodeJS.ProcessEnv = process.env,
): ExecaOptions {
  const { DATABASE_URL: _databaseUrl, ...childEnv } = environment;
  return {
    input: script,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
    extendEnv: false,
  };
}

/** Bound buffer-manager and spill usage. The container still needs an RSS limit. */
export function duckDbResourceSql(
  environment: NodeJS.ProcessEnv = process.env,
  tempDirectory = join(environment.DATA_DIR ?? tmpdir(), "overture", "duckdb-tmp"),
): string {
  const setting = (name: string, fallback: number, max: number) => {
    const value = Number(envString(name, String(fallback), environment));
    if (!Number.isSafeInteger(value) || value <= 0 || value > max)
      throw new Error(`${name} must be a positive bounded integer`);
    return value;
  };
  return `SET temp_directory=${duckDbSqlLiteral(tempDirectory)}; SET memory_limit='${setting("OVERTURE_DUCKDB_MEMORY_MB", 2048, 1048576)}MiB'; SET threads=${setting("OVERTURE_DUCKDB_THREADS", 4, 64)}; SET max_temp_directory_size='${setting("OVERTURE_DUCKDB_TEMP_MB", 32768, 10485760)}MiB'; SET preserve_insertion_order=false;`;
}
