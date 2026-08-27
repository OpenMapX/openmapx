import { existsSync, readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../db/index.js";
import { runOpsOperation } from "../../ops-client.js";
import { assertValidOvertureSchema } from "./schema.js";

const GIB = 1024 ** 3;
const DEFAULT_RESERVE_BYTES = 5 * GIB;
const DEFAULT_FIRST_PULL_BYTES = 2 * GIB;
export const POSTGIS_CONTAINER = "postgis";

function positiveBytesFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer byte count`);
  }
  return parsed;
}

export function freeBytesAt(path: string): number {
  const fs = statfsSync(path);
  return fs.bavail * fs.bsize;
}

export function assertOvertureDiskCapacity(input: {
  stage: string;
  workingBytes: number;
  freeBytes: number;
}): void {
  const reserveBytes = positiveBytesFromEnv("OVERTURE_DISK_RESERVE_BYTES", DEFAULT_RESERVE_BYTES);
  const requiredBytes = Math.ceil(input.workingBytes) + reserveBytes;
  if (input.freeBytes < requiredBytes) {
    throw new Error(
      `Insufficient disk for Overture ${input.stage}: ${input.freeBytes} bytes free, ` +
        `${requiredBytes} required (${Math.ceil(input.workingBytes)} working + ` +
        `${reserveBytes} safety reserve). Free space or increase storage before retrying.`,
    );
  }
}

/**
 * Capacity is reported by the operations agent, which owns the container and
 * the data path. Data-manager holds no Docker socket and names no path.
 */
export async function freeBytesInPostgresContainer(): Promise<number> {
  const result = await runOpsOperation({ kind: "postgis.capacity.inspect" });
  return result.availableBytes;
}

export async function postgresOvertureSchemaBytes(schema: string): Promise<number> {
  assertValidOvertureSchema(schema);
  const [row] = await sql.unsafe<{ bytes: string }[]>(
    `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::TEXT AS bytes
     FROM pg_class AS c
     JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'm')`,
    [schema],
  );
  const bytes = Number(row?.bytes ?? 0);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Invalid PostgreSQL size reported for schema ${schema}`);
  }
  return bytes;
}

export async function postgresFreeBytes(): Promise<number> {
  return freeBytesInPostgresContainer();
}

export async function assertOverturePostgresCapacity(input: {
  schema: string;
  stage: string;
  workingBytes: (schemaBytes: number) => number;
}): Promise<void> {
  const schemaBytes = await postgresOvertureSchemaBytes(input.schema);
  assertOvertureDiskCapacity({
    stage: input.stage,
    workingBytes: input.workingBytes(schemaBytes),
    freeBytes: await postgresFreeBytes(),
  });
}

/**
 * Uses the largest previous regional snapshot as the best local predictor.
 * A first import falls back to a configurable conservative allowance.
 */
export function estimateOverturePullBytes(dataDir: string, regionSlug: string): number {
  const root = join(dataDir, "overture");
  let previousBytes = 0;
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(entry.name)) continue;
      const candidate = join(root, entry.name, `${regionSlug}.parquet`);
      if (existsSync(candidate)) previousBytes = Math.max(previousBytes, statSync(candidate).size);
    }
  }
  const firstPullBytes = positiveBytesFromEnv(
    "OVERTURE_FIRST_PULL_ESTIMATE_BYTES",
    DEFAULT_FIRST_PULL_BYTES,
  );
  return Math.ceil(Math.max(firstPullBytes, previousBytes * 1.5));
}

/** Includes staging tables, post-load indexes, WAL, and temporary headroom. */
export function estimateOvertureIngestBytes(
  parquetBytes: number,
  activeSchemaBytes: number,
): number {
  return Math.ceil(Math.max(4 * GIB, parquetBytes * 4, activeSchemaBytes * 1.5));
}

/** Candidate/component/link workspaces are bounded separately from ingest. */
export function estimateOvertureConflationBytes(placeSchemaBytes: number): number {
  return Math.ceil(Math.max(2 * GIB, placeSchemaBytes * 0.75));
}
