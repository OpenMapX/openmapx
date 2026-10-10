import type postgres from "postgres";

/** Identifiers derive only from a validated UUID, never an operator-supplied path. */
export function planetTable(generation: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(generation))
    throw new Error("Invalid planet generation");
  return `ambient_places.planet_${generation.replaceAll("-", "").toLowerCase()}`;
}
export async function createPlanetStorage(
  tx: postgres.TransactionSql,
  generation: string,
): Promise<void> {
  const table = planetTable(generation);
  // Indexes are maintained per committed page: no unbounded index-build
  // transaction or long-lived source MVCC snapshot at activation.
  await tx.unsafe(`CREATE TABLE ${table} (LIKE ambient_places.planet_features INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
    ALTER TABLE ${table} ADD CHECK(generation='${generation}'::UUID)`);
}
export async function retireAmbientGenerations(tx: postgres.TransactionSql): Promise<void> {
  const expired = await tx.unsafe<{ id: string; storage: string }[]>(
    `SELECT g.id,g.storage FROM ambient_places.generations g WHERE g.publication_status='published' AND g.cache_lease_until<clock_timestamp() AND NOT EXISTS(SELECT 1 FROM ambient_places.state s WHERE g.id=s.active OR g.id=s.previous) ORDER BY g.published_at LIMIT 8`,
  );
  await tx.unsafe(`SET LOCAL lock_timeout='1000ms'`);
  for (const row of expired) {
    if (row.storage === "planet") await tx.unsafe(`DROP TABLE ${planetTable(row.id)}`);
    await tx.unsafe(`DELETE FROM ambient_places.generations WHERE id=$1`, [row.id]);
  }
}
