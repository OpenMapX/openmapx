import { type DiagnosticSnapshot, decimalCounter } from "../../src/postgis/diagnostics";
export function percentile(values: readonly number[], percent: number): number {
  if (
    !values.length ||
    !Number.isFinite(percent) ||
    percent <= 0 ||
    percent > 100 ||
    values.some((v) => !Number.isFinite(v) || v < 0)
  )
    throw new Error("Invalid latency samples");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length * percent) / 100) - 1];
}
export function counterDelta(before: string, after: string): string {
  const delta = BigInt(decimalCounter(after)) - BigInt(decimalCounter(before));
  if (delta < 0n) throw new Error("Diagnostic counter reset during measurement");
  return delta.toString();
}
export interface CpuCounters {
  cpu: number;
  system: number;
  cpus: number;
}
export function sampleCpuPercent(before: CpuCounters, after: CpuCounters): number | null {
  const cpu = after.cpu - before.cpu,
    system = after.system - before.system;
  if (
    ![before.cpu, before.system, after.cpu, after.system, after.cpus].every(Number.isFinite) ||
    cpu < 0 ||
    system <= 0 ||
    after.cpus <= 0
  )
    return null;
  return (cpu / system) * after.cpus * 100;
}
const planKeys = new Set([
  "Node Type",
  "Join Type",
  "Startup Cost",
  "Total Cost",
  "Plan Rows",
  "Plan Width",
  "Actual Startup Time",
  "Actual Total Time",
  "Actual Rows",
  "Actual Loops",
  "Shared Hit Blocks",
  "Shared Read Blocks",
  "Shared Dirtied Blocks",
  "Shared Written Blocks",
  "Temp Read Blocks",
  "Temp Written Blocks",
  "WAL Records",
  "WAL FPI",
  "WAL Bytes",
  "Planning Time",
  "Execution Time",
  "Workers Planned",
  "Workers Launched",
  "Sort Space Used",
  "Rows Removed by Filter",
]);
export function sanitizePlan(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid EXPLAIN plan");
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "Plan") result.Plan = sanitizePlan(field);
    else if (key === "Plans" && Array.isArray(field)) result.Plans = field.map(sanitizePlan);
    else if (planKeys.has(key) && (typeof field === "string" || typeof field === "number")) {
      if (typeof field === "number" && !Number.isFinite(field))
        throw new Error("Invalid EXPLAIN metric");
      // Only these enumerations are textual; arbitrary strings are never exported.
      if (
        typeof field === "string" &&
        !((key === "Node Type" || key === "Join Type") && /^[A-Za-z ]+$/.test(field))
      )
        throw new Error("Invalid EXPLAIN node");
      result[key] = field;
    }
  }
  return result;
}
export function diagnosticDelta(
  before: DiagnosticSnapshot,
  after: DiagnosticSnapshot,
): Record<string, string> {
  if (
    BigInt(before.statementCount) > 50n ||
    BigInt(after.statementCount) > 50n ||
    before.deallocations !== after.deallocations
  )
    throw new Error("Diagnostic statement inventory truncated or evicted during measurement");
  if (before.statsReset !== after.statsReset)
    throw new Error("Diagnostic counter reset during measurement");
  const previous = new Map(before.statements.map((row) => [row.queryId, row]));
  const current = new Map(after.statements.map((row) => [row.queryId, row]));
  for (const [id, row] of previous) {
    const next = current.get(id);
    if (!next || row.statsSince !== next.statsSince)
      throw new Error("Diagnostic statement reset during measurement");
    for (const key of [
      "calls",
      "rows",
      "sharedHitBlocks",
      "sharedReadBlocks",
      "tempReadBlocks",
      "tempWrittenBlocks",
      "walBytes",
    ] as const)
      counterDelta(row[key] ?? "0", next[key] ?? "0");
  }
  const keys = [
    "calls",
    "rows",
    "sharedHitBlocks",
    "sharedReadBlocks",
    "tempReadBlocks",
    "tempWrittenBlocks",
    "walBytes",
  ] as const;
  const totals = (snapshot: DiagnosticSnapshot, key: (typeof keys)[number]) =>
    snapshot.statements.reduce((sum, row) => sum + BigInt(row[key] ?? "0"), 0n).toString();
  return Object.fromEntries(
    keys.map((key) => [key, counterDelta(totals(before, key), totals(after, key))]),
  );
}
