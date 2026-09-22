/** Disposable synthetic benchmark; never uses DATABASE_URL or imported data. */
import { performance } from "node:perf_hooks";
import { latLngToCell } from "h3-js";
import { startPostgis } from "../__tests__/poi-ingest/_testcontainer.js";
import { buildSchemaDDL } from "../src/jobs/overture/schema.js";

const pg = await startPostgis();
try {
  for (const algorithm of ["baseline", "keyset", "keyset", "baseline"]) {
    await pg.sql.unsafe(buildSchemaDDL("overture_bench", { deferPlacesIndexes: true }));
    await pg.sql.unsafe(`INSERT INTO overture_bench.places (gers_id, geom, h3_r8, release)
      SELECT lpad(i::text, 8, '0'), ST_SetSRID(ST_MakePoint(8 + (i % 100) / 10000.0, 50),4326),
        CASE WHEN i % 7 = 0 THEN 'prefilled' ELSE NULL END, 'synthetic'
      FROM generate_series(1,100000) i`);
    await pg.sql.unsafe("ANALYZE overture_bench.places");
    let cursor: string | undefined;
    let batches = 0;
    let calls = 0;
    let buffers = 0;
    const plans: unknown[] = [];
    const started = performance.now();
    for (;;) {
      const params = cursor && algorithm === "keyset" ? [cursor] : [];
      const query = `SELECT gers_id, ST_Y(geom) AS lat, ST_X(geom) AS lng FROM overture_bench.places
        WHERE h3_r8 IS NULL ${params.length ? "AND gers_id > $1" : ""}
        ${algorithm === "keyset" ? "ORDER BY gers_id" : ""} LIMIT 5000`;
      const explained = await pg.sql.unsafe(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
        params,
      );
      const plan = explained[0]["QUERY PLAN"][0];
      buffers += plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"];
      if (batches === 0 || batches >= 16) plans.push({ batch: batches, ...plan });
      const rows = await pg.sql.unsafe<{ gers_id: string; lat: number; lng: number }[]>(
        query,
        params,
      );
      calls++;
      if (!rows.length) break;
      await pg.sql.unsafe(
        `UPDATE overture_bench.places p SET h3_r8 = v.h3
        FROM (SELECT UNNEST($1::text[]) gers_id, UNNEST($2::text[]) h3) v
        WHERE p.gers_id = v.gers_id AND p.h3_r8 IS NULL`,
        [rows.map((r) => r.gers_id), rows.map((r) => latLngToCell(r.lat, r.lng, 8))],
      );
      calls++;
      cursor = rows.at(-1)?.gers_id;
      batches++;
    }
    const [counts] =
      await pg.sql.unsafe(`SELECT count(*) FILTER (WHERE h3_r8 IS NULL)::int AS remaining,
      count(*) FILTER (WHERE h3_r8 = 'prefilled')::int AS prefilled FROM overture_bench.places`);
    console.log(
      JSON.stringify({
        algorithm,
        rows: 100000,
        batches,
        calls,
        readBuffers: buffers,
        elapsedMsIncludingExplain: performance.now() - started,
        counts,
        plans,
      }),
    );
  }
} finally {
  await pg.stop();
}
