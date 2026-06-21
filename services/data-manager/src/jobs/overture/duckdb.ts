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

/**
 * Runs `duckdb` with the given args, rethrowing a redacted error on failure so
 * an embedded Postgres password never reaches logs. Pass-through `options` keep
 * each call site's stdio/format (e.g. `-csv`, `stdio: "pipe"` vs `"inherit"`).
 */
export async function runDuckDb(args: string[], options?: ExecaOptions): Promise<ExecaResult> {
  try {
    return (await execa("duckdb", args, options ?? {})) as ExecaResult;
  } catch (err) {
    const e = err as { message?: string; stderr?: unknown; exitCode?: number };
    const parts = [redactConnectionString(e.message ?? "duckdb command failed")];
    if (typeof e.stderr === "string" && e.stderr.trim()) {
      parts.push(redactConnectionString(e.stderr));
    }
    throw new Error(parts.join("\n"));
  }
}
