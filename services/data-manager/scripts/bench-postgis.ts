/** Always disposable: DATABASE_URL is intentionally never read. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runBenchmark } from "./postgis/benchmark.js";
import { benchmarkOptions, markdownReport, writeReports } from "./postgis/report.js";

const abort = new AbortController();
const cancel = () => abort.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const options = benchmarkOptions(process.argv.slice(2));
  if (existsSync(resolve(options.output))) throw new Error("Use a new output directory");
  const result = await runBenchmark({ smoke: options.smoke, signal: abort.signal });
  const markdown = markdownReport(result);
  abort.signal.throwIfAborted();
  writeReports(options.output, `${JSON.stringify(result, null, 2)}\n`, markdown);
  process.stdout.write(
    `Synthetic ${result.mode}: ${result.cases.length} scenarios passed; reports written to ${resolve(options.output)}\n`,
  );
} catch {
  process.stderr.write(
    "PostGIS benchmark failed: check Docker availability, PostgreSQL 18 instrumentation, resource limits, arguments, and fixture correctness. No success report was produced.\n",
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
