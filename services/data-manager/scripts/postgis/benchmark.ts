import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { collectDiagnostics } from "../../src/postgis/diagnostics";
import { type BenchmarkDatabase, startBenchmarkDatabase } from "./container";
import {
  type CpuCounters,
  diagnosticDelta,
  percentile,
  sampleCpuPercent,
  sanitizePlan,
} from "./metrics";
import {
  type BenchmarkReport,
  type CaseResult,
  fixtureChecksum,
  requireCompleteReport,
} from "./report";
import {
  createFixture,
  operations,
  resetMutation,
  runOperation,
  type WorkloadName,
  workloadNames,
} from "./workloads";

const root = resolve(import.meta.dirname, "../../../..");
export async function runBenchmark(options: {
  smoke: boolean;
  signal?: AbortSignal;
}): Promise<BenchmarkReport> {
  options.signal?.throwIfAborted();
  const db = await startBenchmarkDatabase();
  try {
    options.signal?.throwIfAborted();
    const pois = options.smoke ? 1000 : 100000,
      accounts = options.smoke ? 1000 : 10000,
      samples = options.smoke ? 12 : 100;
    await createFixture(db.sql, pois, accounts);
    const [checksum] = await db.sql.unsafe(
      `SELECT md5(concat((SELECT string_agg(gers_id||name||ST_AsEWKB(geom)::text||h3_r8,',' ORDER BY gers_id) FROM overture_benchmark.places),(SELECT string_agg(id||term,',' ORDER BY id) FROM benchmark_terms),(SELECT string_agg(id::text||user_id::text||status||sort_order::text,',' ORDER BY id) FROM benchmark_api))) AS checksum`,
    );
    const initial = await collectDiagnostics(db.sql);
    const cases: CaseResult[] = [];
    for (const name of workloadNames)
      for (const concurrency of [1, 4]) {
        options.signal?.throwIfAborted();
        await resetMutation(db.sql, name, samples + 5);
        for (let i = 0; i < 5; i++) await runOperation(db.sql, name, i, pois);
        await resetMutation(db.sql, name, samples);
        cases.push(await measureCase(db, name, concurrency, samples, pois, options.signal));
      }
    options.signal?.throwIfAborted();
    requireCompleteReport(cases);
    const sourceChecksum = createHash("sha256")
      .update(
        ["container", "metrics", "workloads", "benchmark", "report"]
          .map((name) => readFileSync(resolve(import.meta.dirname, `${name}.ts`), "utf8"))
          .concat(
            [
              "services/data-manager/src/postgis/diagnostics.ts",
              "services/data-manager/src/jobs/overture/schema.ts",
              "services/data-manager/scripts/bench-postgis.ts",
              "services/postgis/scripts/sync-password.sh",
              "services/postgis/service.json",
              "pnpm-lock.yaml",
            ].map((path) => readFileSync(resolve(root, path), "utf8")),
          )
          .join("\n"),
      )
      .digest("hex");
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      synthetic: true,
      mode: options.smoke ? "smoke" : "baseline",
      gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      worktreeDirty:
        execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
          cwd: root,
          encoding: "utf8",
        }).trim().length > 0,
      sourceChecksum,
      fixture: {
        revision: 1,
        seed: 1,
        pois,
        accounts,
        configurationChecksum: fixtureChecksum(pois, accounts),
        dataChecksum: String(checksum.checksum),
      },
      environment: db.metadata,
      settings: initial.settings,
      cases,
    };
  } finally {
    await db.stop();
    options.signal?.throwIfAborted();
  }
}
async function measureCase(
  db: BenchmarkDatabase,
  name: WorkloadName,
  concurrency: number,
  count: number,
  pois: number,
  signal?: AbortSignal,
): Promise<CaseResult> {
  const before = await collectDiagnostics(db.sql);
  const observations: { cpu: number | null; memory: number; waiting: bigint }[] = [];
  let previous: CpuCounters | undefined;
  const capture = async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stats = await Promise.race([
      db.raw.stats({ stream: false, "one-shot": true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Container resource sampling timeout")), 5000);
      }),
    ]).finally(() => clearTimeout(timeout));
    const cpu: CpuCounters = {
      cpu: stats.cpu_stats.cpu_usage.total_usage,
      system: stats.cpu_stats.system_cpu_usage,
      cpus: stats.cpu_stats.online_cpus ?? stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1,
    };
    const [locks] = await db.sql.unsafe(
      "SELECT count(*) FILTER (WHERE NOT granted)::text AS waiting FROM pg_locks",
    );
    if (
      !Number.isFinite(stats.memory_stats.usage) ||
      !Number.isFinite(cpu.cpu) ||
      !Number.isFinite(cpu.system)
    )
      throw new Error("Container resource sampling unavailable");
    observations.push({
      cpu: previous ? sampleCpuPercent(previous, cpu) : null,
      memory: stats.memory_stats.usage,
      waiting: BigInt(locks.waiting),
    });
    previous = cpu;
  };
  await capture();
  let observerFailure: unknown,
    stop = false;
  const observerAbort = new AbortController();
  const observer = (async () => {
    try {
      while (!stop) {
        try {
          await delay(100, undefined, { signal: observerAbort.signal });
        } catch (error) {
          if (stop && observerAbort.signal.aborted) return;
          throw error;
        }
        if (!stop) await capture();
      }
    } catch (error) {
      observerFailure = error;
    }
  })();
  const timings: number[] = [];
  let next = 0;
  const started = performance.now();
  let wallMs = 0;
  try {
    const workers = await Promise.allSettled(
      Array.from({ length: concurrency }, async () => {
        while (next < count) {
          signal?.throwIfAborted();
          if (observerFailure) throw observerFailure;
          const index = next++;
          const start = performance.now();
          await runOperation(db.sql, name, index, pois);
          signal?.throwIfAborted();
          timings.push(performance.now() - start);
        }
      }),
    );
    wallMs = performance.now() - started;
    const failed = workers.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } finally {
    stop = true;
    observerAbort.abort();
    await observer;
  }
  if (observerFailure) throw observerFailure;
  await capture();
  signal?.throwIfAborted();
  const after = await collectDiagnostics(db.sql);
  if (timings.length !== count) throw new Error("Incomplete benchmark timing samples");
  const plans: Record<string, unknown>[] = [];
  await resetMutation(db.sql, name, count);
  await db.sql
    .begin(async (transaction) => {
      for (const operation of operations(name, 0, pois)) {
        signal?.throwIfAborted();
        const rows = await transaction.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${operation.query}`,
          operation.parameters,
        );
        plans.push(sanitizePlan(rows[0]["QUERY PLAN"][0]));
      }
      // Roll back write plan capture without committing a new fixture state.
      throw new Error("ROLLBACK_SYNTHETIC_EXPLAIN");
    })
    .catch((error) => {
      if (!(error instanceof Error) || error.message !== "ROLLBACK_SYNTHETIC_EXPLAIN") throw error;
    });
  signal?.throwIfAborted();
  const cpuSamples = observations.flatMap((row) => (row.cpu === null ? [] : [row.cpu]));
  return {
    workload: name,
    concurrency,
    samples: count,
    warmups: 5,
    p50Ms: percentile(timings, 50),
    p95Ms: percentile(timings, 95),
    wallMs,
    operationsPerSecond: (count / wallMs) * 1000,
    counters: diagnosticDelta(before, after),
    plans,
    resources: {
      sampleCount: observations.length,
      cpuSampleCount: cpuSamples.length,
      maximumCpuPercent: cpuSamples.length ? Math.max(...cpuSamples) : null,
      maximumMemoryBytes: Math.max(...observations.map((row) => row.memory)),
      maximumWaitingLocks: observations
        .reduce((max, row) => (row.waiting > max ? row.waiting : max), 0n)
        .toString(),
    },
    correctness: "passed",
  };
}
