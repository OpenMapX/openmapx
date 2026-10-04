/** Synthetic query shapes: not full provider or ingestion-pipeline timings. */
import type postgres from "postgres";
import { buildSchemaDDL } from "../../src/jobs/overture/schema";
export type BenchmarkSql = ReturnType<typeof postgres>;
export const workloadNames = ["search", "conflation", "ingestion", "cleanup", "api"] as const;
export type WorkloadName = (typeof workloadNames)[number];
export interface Operation {
  query: string;
  parameters: (string | number | string[])[];
  check: (rows: Record<string, unknown>[]) => void;
}
function requireRows(rows: Record<string, unknown>[], count: number) {
  if (rows.length !== count) throw new Error("Synthetic workload correctness failure");
}
function requireIds(rows: Record<string, unknown>[], expected: number[]) {
  requireRows(rows, expected.length);
  const actual = rows.map((row) => Number(row.id)).sort((a, b) => a - b);
  if (actual.some((id, index) => id !== expected[index]))
    throw new Error("Synthetic identity mismatch");
}
const proximityCache = new Map<number, string[]>();
function nearestIds(pois: number): string[] {
  let expected = proximityCache.get(pois);
  if (!expected) {
    expected = Array.from({ length: Math.min(pois, 10000) }, (_, index) => index + 1)
      .map((i) => ({
        id: String(i).padStart(8, "0"),
        distance: Math.hypot(8 + (i % 1000) * 0.0001 - 8, 50 + Math.floor(i / 1000) * 0.0001 - 50),
      }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
      .slice(0, 10)
      .map((row) => row.id);
    proximityCache.set(pois, expected);
  }
  return expected;
}
export const provenance = {
  search:
    "integrations/search-osm-aliases/provider.ts: lexical join/proximity; simplified single exact alias and PostGIS geometry bbox",
  conflation:
    "services/data-manager/src/jobs/overture/conflate.ts: H3-blocked candidate retrieval; extra indexed spatial join is a database-only scoring proxy, not full JS matching",
  ingestion:
    "services/data-manager/src/jobs/overture/schema.ts and extract-osm-pois.ts: batched insert/conflict updates; synthetic stable IDs",
  cleanup:
    "apps/api/src/services/activity-retention.ts: age-filtered retention deletions; bounded synthetic obsolete-row batches, not complete retention jobs or Overture filesystem pruning",
  api: "apps/api/src/db/saved-schema.ts and admin-job-schema.ts: owner-scoped list reads and status-filtered job reads; reduced synthetic schema",
} as const;
export async function createFixture(sql: BenchmarkSql, pois: number, accounts: number) {
  await sql.unsafe(buildSchemaDDL("overture_benchmark"));
  await sql.unsafe(
    `INSERT INTO overture_benchmark.places(gers_id,name,geom,h3_r8,basic_category,release)
  SELECT lpad(i::text,8,'0'),'Synthetic '||i,ST_SetSRID(ST_MakePoint(8+(i%1000)*0.0001,50+(i/1000)*0.0001),4326),
  'synthetic-cell-'||(i%100)::text,'cafe','synthetic-v1' FROM generate_series(1,$1::int) i`,
    [pois],
  );
  await sql.unsafe(`CREATE TABLE benchmark_terms(id text PRIMARY KEY REFERENCES overture_benchmark.places(gers_id),term text NOT NULL);
  CREATE INDEX benchmark_terms_lookup ON benchmark_terms(term);
  INSERT INTO benchmark_terms SELECT gers_id,lower(name) FROM overture_benchmark.places;
  CREATE TABLE benchmark_api(id int PRIMARY KEY,user_id int NOT NULL,status text NOT NULL,sort_order int NOT NULL);
  CREATE INDEX benchmark_api_owner ON benchmark_api(user_id,sort_order);
  CREATE INDEX benchmark_api_status ON benchmark_api(status,id);
  CREATE TABLE benchmark_ingest(id int PRIMARY KEY,value int NOT NULL);
  CREATE TABLE benchmark_cleanup(id int PRIMARY KEY,obsolete boolean NOT NULL);
  CREATE INDEX benchmark_cleanup_obsolete ON benchmark_cleanup(obsolete,id)`);
  await sql.unsafe(
    `INSERT INTO benchmark_api SELECT i,(i-1)/10,'queued',i%10 FROM generate_series(1,$1::int) i`,
    [accounts],
  );
  await sql.unsafe(
    "ANALYZE overture_benchmark.places; ANALYZE benchmark_terms; ANALYZE benchmark_api",
  );
}
export async function resetMutation(sql: BenchmarkSql, name: WorkloadName, operations: number) {
  if (name === "ingestion") {
    await sql.unsafe("TRUNCATE benchmark_ingest");
    await sql.unsafe(
      "INSERT INTO benchmark_ingest SELECT i,0 FROM generate_series(1,$1::int) i WHERE i%2=0",
      [operations * 10],
    );
  } else if (name === "cleanup") {
    await sql.unsafe("TRUNCATE benchmark_cleanup");
    await sql.unsafe(
      "INSERT INTO benchmark_cleanup SELECT i,true FROM generate_series(1,$1::int) i",
      [operations * 10],
    );
  }
  if (name === "ingestion" || name === "cleanup")
    await sql.unsafe(`ANALYZE benchmark_${name === "ingestion" ? "ingest" : "cleanup"}`);
}
export function operations(name: WorkloadName, index: number, pois: number): Operation[] {
  const id = String((index % pois) + 1).padStart(8, "0");
  const number = (index % pois) + 1;
  switch (name) {
    case "search":
      return [
        {
          query: `SELECT p.gers_id FROM benchmark_terms t JOIN overture_benchmark.places p ON p.gers_id=t.id
    WHERE t.term=$1 ORDER BY p.gers_id LIMIT 10`,
          parameters: [`synthetic ${number}`],
          check: (rows) => {
            requireRows(rows, 1);
            if (rows[0].gers_id !== id) throw new Error("Search fixture mismatch");
          },
        },
        {
          query: `SELECT gers_id FROM overture_benchmark.places WHERE geom && ST_MakeEnvelope(8,50,8.02,50.02,4326)
     ORDER BY ST_Distance(geom,ST_SetSRID(ST_MakePoint(8,50),4326)),gers_id LIMIT 10`,
          parameters: [],
          check: (rows) => {
            const expected = nearestIds(pois);
            requireRows(rows, 10);
            if (rows.some((row, index) => row.gers_id !== expected[index]))
              throw new Error("Proximity fixture mismatch");
          },
        },
      ];
    case "conflation":
      return [
        {
          query: `SELECT gers_id FROM overture_benchmark.places
    WHERE h3_r8=$1 AND (operating_status IS NULL OR operating_status<>'permanently_closed')
    AND (confidence IS NULL OR confidence>=0.5) ORDER BY gers_id LIMIT 10`,
          parameters: [`synthetic-cell-${number % 100}`],
          check: (rows) => {
            requireRows(rows, 10);
            if (
              !rows.every(
                (row, index) => Number(row.gers_id) === (number % 100 || 100) + index * 100,
              )
            )
              throw new Error("Candidate fixture mismatch");
          },
        },
        {
          query: `SELECT p.gers_id FROM overture_benchmark.places p JOIN overture_benchmark.places q
     ON p.geom && ST_Expand(q.geom,0.000001) AND ST_DWithin(p.geom,q.geom,0.000001)
     WHERE q.gers_id=$1 ORDER BY p.gers_id`,
          parameters: [id],
          check: (rows) => {
            requireRows(rows, 1);
            if (rows[0].gers_id !== id) throw new Error("Spatial fixture mismatch");
          },
        },
      ];
    case "ingestion":
      return [
        {
          query: `INSERT INTO benchmark_ingest(id,value)
    SELECT i,1 FROM generate_series($1::int,$2::int) i ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value RETURNING id,value`,
          parameters: [index * 10 + 1, index * 10 + 10],
          check: (rows) => {
            requireIds(
              rows,
              Array.from({ length: 10 }, (_, i) => index * 10 + i + 1),
            );
            if (rows.some((row) => row.value !== 1)) throw new Error("Upsert fixture mismatch");
          },
        },
      ];
    case "cleanup":
      return [
        {
          query: `DELETE FROM benchmark_cleanup WHERE id BETWEEN $1::int AND $2::int AND obsolete RETURNING id`,
          parameters: [index * 10 + 1, index * 10 + 10],
          check: (rows) =>
            requireIds(
              rows,
              Array.from({ length: 10 }, (_, i) => index * 10 + i + 1),
            ),
        },
      ];
    case "api":
      return [
        {
          query: `SELECT id,user_id FROM benchmark_api WHERE user_id=$1 ORDER BY sort_order,id`,
          parameters: [index % 100],
          check: (rows) => {
            requireIds(
              rows,
              Array.from({ length: 10 }, (_, i) => (index % 100) * 10 + i + 1),
            );
            if (rows.some((row) => row.user_id !== index % 100))
              throw new Error("Owner fixture mismatch");
          },
        },
        {
          query: `SELECT id FROM benchmark_api WHERE status=$1 ORDER BY id LIMIT 10`,
          parameters: ["queued"],
          check: (rows) =>
            requireIds(
              rows,
              Array.from({ length: 10 }, (_, i) => i + 1),
            ),
        },
      ];
  }
}
export async function runOperation(
  sql: BenchmarkSql,
  name: WorkloadName,
  index: number,
  pois: number,
) {
  for (const operation of operations(name, index, pois)) {
    const rows = await sql.unsafe(operation.query, operation.parameters);
    operation.check(rows);
  }
}
