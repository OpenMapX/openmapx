import { sql } from "../../db/index.js";
import { assertValidOvertureSchema } from "./schema.js";

/** Exact connected components, with graph state on disk rather than one
 * planet-wide Node UnionFind. Labels decrease monotonically through shared
 * GERS endpoints until a round changes nothing; the fixed point is the minimum
 * initial OSM label in each connected component, independent of page order.
 * Retry reconstructs the unlogged workspace from durable candidate edges.
 */
export async function buildConflationComponents(
  schema: string,
  onProgress?: (message: string) => void,
): Promise<number> {
  assertValidOvertureSchema(schema);
  const table = `"${schema}".poi_conflation_component`;
  const edges = `"${schema}".poi_conflation_candidate`;
  const proposals = `"${schema}".poi_conflation_proposal`;
  await sql.unsafe(`TRUNCATE ${table},"${schema}".poi_conflation_link_next`);
  await sql.unsafe(`INSERT INTO ${table}(osm_type,osm_id,component_id)
    SELECT osm_type,osm_id,row_number() OVER(ORDER BY osm_type,osm_id)
    FROM (SELECT DISTINCT osm_type,osm_id FROM ${edges}) endpoints`);
  await sql.unsafe(`ANALYZE ${table}`);
  let round = 0;
  try {
    while (true) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${proposals}`);
      await sql.unsafe(`CREATE UNLOGGED TABLE ${proposals} AS
        WITH gers_labels AS (
          SELECT e.gers_id,min(c.component_id) AS label
          FROM ${edges} e JOIN ${table} c USING(osm_type,osm_id) GROUP BY e.gers_id
        ) SELECT e.osm_type,e.osm_id,min(g.label) AS label
        FROM ${edges} e JOIN gers_labels g USING(gers_id)
        JOIN ${table} c USING(osm_type,osm_id)
        GROUP BY e.osm_type,e.osm_id,c.component_id HAVING min(g.label)<c.component_id`);
      await sql.unsafe(
        `CREATE UNIQUE INDEX ON ${proposals}(osm_type,osm_id); ANALYZE ${proposals}`,
      );
      let cursorType = "";
      let cursorId = "0";
      let changed = 0;
      while (true) {
        const [page] = await sql.unsafe<
          { osm_type: string | null; osm_id: string | null; n: number }[]
        >(
          `
          WITH batch AS MATERIALIZED (SELECT * FROM ${proposals}
            WHERE (osm_type,osm_id)>($1,$2::BIGINT) ORDER BY osm_type,osm_id LIMIT 10000),
          updated AS (UPDATE ${table} c SET component_id=b.label FROM batch b
            WHERE c.osm_type=b.osm_type AND c.osm_id=b.osm_id RETURNING 1)
          SELECT (SELECT osm_type FROM batch ORDER BY osm_type DESC,osm_id DESC LIMIT 1) AS osm_type,
            (SELECT osm_id::TEXT FROM batch ORDER BY osm_type DESC,osm_id DESC LIMIT 1) AS osm_id,
            (SELECT count(*)::INT FROM updated) AS n`,
          [cursorType, cursorId],
        );
        if (!page.n || page.osm_type === null || page.osm_id === null) break;
        cursorType = page.osm_type;
        cursorId = page.osm_id;
        changed += page.n;
      }
      onProgress?.(`Component propagation round ${++round}: ${changed} labels changed`);
      if (!changed) break;
    }
    await sql.unsafe(`UPDATE ${table} c SET component_id=r.id FROM
      (SELECT component_id,dense_rank() OVER(ORDER BY component_id) AS id FROM ${table} GROUP BY component_id) r
      WHERE c.component_id=r.component_id`);
    await sql.unsafe(`ANALYZE ${table}`);
    const [result] = await sql.unsafe<{ n: string }[]>(
      `SELECT coalesce(max(component_id),0)::TEXT AS n FROM ${table}`,
    );
    return Number(result.n);
  } finally {
    await sql.unsafe(`DROP TABLE IF EXISTS ${proposals}`);
  }
}
