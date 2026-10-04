import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DiagnosticSnapshot } from "../../src/postgis/diagnostics";
import type { WorkloadName } from "./workloads";
import { provenance, workloadNames } from "./workloads";
export interface CaseResult {
  workload: WorkloadName;
  concurrency: number;
  samples: number;
  warmups: number;
  p50Ms: number;
  p95Ms: number;
  wallMs: number;
  operationsPerSecond: number;
  counters: Record<string, string>;
  plans: Record<string, unknown>[];
  resources: {
    sampleCount: number;
    cpuSampleCount: number;
    maximumCpuPercent: number | null;
    maximumMemoryBytes: number;
    maximumWaitingLocks: string;
  };
  correctness: "passed";
}
export function benchmarkOptions(args: string[]): { smoke: boolean; output: string } {
  let smoke = false,
    output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--smoke" && !smoke) smoke = true;
    else if (
      args[i] === "--output" &&
      output === undefined &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    )
      output = args[++i];
    else
      throw new Error(
        "Use only --smoke and --output DIRECTORY; external database targets are not supported.",
      );
  }
  if (!output) throw new Error("An explicit --output DIRECTORY is required.");
  return { smoke, output };
}
export function fixtureChecksum(pois: number, accounts: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ revision: 1, seed: 1, pois, accounts }))
    .digest("hex");
}
export function requireCompleteReport(cases: readonly CaseResult[]): void {
  const expected = new Set(workloadNames.flatMap((name) => [`${name}:1`, `${name}:4`]));
  if (cases.length !== expected.size) throw new Error("Incomplete benchmark report");
  for (const row of cases) {
    const key = `${row.workload}:${row.concurrency}`;
    if (
      !expected.delete(key) ||
      row.correctness !== "passed" ||
      !Number.isInteger(row.samples) ||
      row.samples < 1 ||
      !Number.isInteger(row.warmups) ||
      row.warmups < 0 ||
      ![
        row.p50Ms,
        row.p95Ms,
        row.wallMs,
        row.operationsPerSecond,
        row.resources.maximumCpuPercent,
        row.resources.maximumMemoryBytes,
      ].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) ||
      row.wallMs <= 0 ||
      row.operationsPerSecond <= 0 ||
      !/^[0-9]+$/.test(row.resources.maximumWaitingLocks) ||
      [
        "calls",
        "rows",
        "sharedHitBlocks",
        "sharedReadBlocks",
        "tempReadBlocks",
        "tempWrittenBlocks",
        "walBytes",
      ].some((key) => !/^[0-9]+$/.test(row.counters[key] ?? "")) ||
      row.plans.length < 1 ||
      row.resources.sampleCount < 2 ||
      row.resources.cpuSampleCount < 1 ||
      row.resources.maximumCpuPercent === null ||
      !Number.isFinite(row.p95Ms) ||
      row.p95Ms < row.p50Ms
    )
      throw new Error("Incomplete benchmark report");
  }
}
export interface BenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  synthetic: true;
  mode: "smoke" | "baseline";
  gitCommit: string;
  sourceChecksum: string;
  worktreeDirty: boolean;
  fixture: {
    revision: 1;
    seed: 1;
    pois: number;
    accounts: number;
    configurationChecksum: string;
    dataChecksum: string;
  };
  environment: Record<string, string | number>;
  settings: DiagnosticSnapshot["settings"];
  cases: CaseResult[];
}
export function markdownReport(report: BenchmarkReport): string {
  requireCompleteReport(report.cases);
  const rows = report.cases.map(
    (row) =>
      `| ${row.workload} | ${row.concurrency} | ${row.samples} | ${row.p50Ms.toFixed(3)} | ${row.p95Ms.toFixed(3)} | ${row.operationsPerSecond.toFixed(1)} | ${row.counters.sharedReadBlocks} | ${row.counters.tempWrittenBlocks} | ${row.counters.walBytes} | ${row.resources.maximumCpuPercent?.toFixed(1)} | ${(row.resources.maximumMemoryBytes / 1024 ** 2).toFixed(1)} | ${row.resources.maximumWaitingLocks} |`,
  );
  return `# Synthetic PostGIS ${report.mode} report\n\nGenerated: ${report.generatedAt}\n\nCheckout commit: \`${report.gitCommit}\`; uncommitted checkout changes: ${report.worktreeDirty}; SHA-256 source checksum: \`${report.sourceChecksum}\`.\n\n**This is a disposable-container synthetic query baseline, not production OpenMapX performance. No tuning profiles are justified by this run alone.**\n\n## Environment\n\n${Object.entries(
    report.environment,
  )
    .map(([key, value]) => `- ${key}: \`${value}\``)
    .join(
      "\n",
    )}\n\n## Fixture and methodology\n\n- Fixture revision ${report.fixture.revision}, seed ${report.fixture.seed}; ${report.fixture.pois} invented POIs and ${report.fixture.accounts} invented API records.\n- Fixture configuration checksum: \`${report.fixture.configurationChecksum}\`. Ordered fixture data checksum (MD5): \`${report.fixture.dataChecksum}\`.\n- Fresh container, analyzed/indexed fixtures; five warmup operations before each scenario. No cold-cache claim.\n- p50/p95 are nearest-rank percentiles of individual client wall-clock operation samples. A family operation may execute multiple queries.\n- Worker concurrency is 1 or 4; throughput uses the whole measurement window. Fixture/reset and independent EXPLAIN windows are excluded.\n- Resource and lock observations are sampled at a nominal 100 ms interval plus initial/final observations. Actual acquisition can take longer; sampled maxima are not exact peaks. CPU 100% means one core; the container limit is two cores. Memory includes cache.\n- Counter deltas include measurement observer queries; they are window-level statistics, not per-request attribution. Top-50 retention and reset validity are checked.\n- EXPLAIN ANALYZE executes on synthetic data only. Write plan capture is rolled back; rollback does not undo WAL. Literal expressions and relation names are removed from exported plans.\n- Smoke mode is a correctness/instrumentation check and is unsuitable for tuning comparisons.\n\n## Measurements\n\nAll scenarios passed result correctness checks.\n\n| Workload | Workers | Samples | p50 ms | p95 ms | Ops/s | Shared reads | Temp writes | WAL bytes | CPU max % | Memory max MiB | Waiting locks max |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join("\n")}\n\n## Query provenance and simplifications\n\n${Object.entries(
    provenance,
  )
    .map(([name, description]) => `- **${name}:** ${description}.`)
    .join(
      "\n",
    )}\n\n## Interpretation and next steps\n\nProduction PostgreSQL defaults remain unchanged. The suite covers specified database query shapes, not network traffic, complete provider adapters, real regional distributions, or end-to-end ingestion. Repeat on the same resource allocation for candidate settings, then evaluate real regional data and representative traffic before recommending small/default/large deployment profiles. Timing thresholds are not portable correctness gates. Full settings, sanitized plans, resource sample counts, and counter deltas are in the companion JSON report.\n`;
}

/** Publish the pair by one directory rename; never overwrite a previous run. */
export function writeReports(output: string, json: string, markdown: string): void {
  const destination = resolve(output);
  if (existsSync(destination)) throw new Error("Use a new output directory for each benchmark run");
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), ".postgis-report-"));
  try {
    writeFileSync(join(staging, "postgis-baseline.json"), json);
    writeFileSync(join(staging, "postgis-baseline.md"), markdown);
    if (existsSync(destination)) throw new Error("Benchmark output already exists");
    renameSync(staging, destination);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
