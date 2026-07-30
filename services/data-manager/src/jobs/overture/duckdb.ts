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
  try {
    return (await execa("duckdb", args, options ?? {})) as ExecaResult;
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
