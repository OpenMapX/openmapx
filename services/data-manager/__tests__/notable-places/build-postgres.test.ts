import { describe, expect, it } from "vitest";
import { buildNotablePlaces } from "../../src/jobs/notable-places/build.js";
import { createNotablePlacesRuntimeState } from "../../src/jobs/notable-places/state.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

const ENTITY = "<http://www.wikidata.org/entity/";

/**
 * Enough places to pass the build's sanity floor, the Eiffel Tower among
 * them, Rome as a city, and a crater on the Moon.
 */
function places(): string {
  const rows = [
    `${ENTITY}Q243>\tPOINT(2.294479 48.858296)\t191\t"place"`,
    `${ENTITY}Q220>\tPOINT(12.482778 41.893056)\t344\t"settlement"`,
    `${ENTITY}Q1429008>\t"${ENTITY}Q405> Point(137.76 -1.85)"^^<http://www.opengis.net/ont/geosparql#wktLiteral>\t30\t"place"`,
  ];
  for (let i = 1; i <= 1_200; i++) {
    rows.push(`${ENTITY}Q${100_000 + i}>\tPOINT(${i / 100} 10)\t8\t"place"`);
  }
  return `?item\t?coord\t?links\t?kind\n${rows.join("\n")}\n`;
}

/** Answers each query the build sends the way QLever does. */
function fakeEndpoint(failPlaces = false): typeof fetch {
  return async (_url, init) => {
    const query = new URLSearchParams(String(init?.body)).get("query") ?? "";
    const tsv = (header: string, rows: string[]) =>
      new Response(`${header}\n${rows.join("\n")}\n`, { status: 200 });
    if (query.includes("SELECT ?item ?coord ?links")) {
      return failPlaces ? new Response("broken", { status: 500 }) : new Response(places());
    }
    const label = /@(\w+)@rdfs:label/.exec(query)?.[1];
    if (label === "en") {
      const others = Array.from(
        { length: 1_200 },
        (_, i) => `${ENTITY}Q${100_001 + i}>\t"Place ${i}"@en`,
      );
      return tsv("?item\t?name", [
        `${ENTITY}Q243>\t"Eiffel Tower"@en`,
        `${ENTITY}Q220>\t"Rome"@en`,
        `${ENTITY}Q1429008>\t"Gale"@en`,
        ...others,
      ]);
    }
    if (label === "fr") return tsv("?item\t?name", [`${ENTITY}Q243>\t"tour Eiffel"@fr`]);
    if (label === "de") {
      return tsv("?item\t?name", [`${ENTITY}Q243>\t"Eiffelturm"@de`, `${ENTITY}Q220>\t"Rom"@de`]);
    }
    if (/@en@skos:altLabel/.test(query)) {
      return tsv("?item\t?name", [
        `${ENTITY}Q243>\t"Eiffel Tower"@en`,
        `${ENTITY}Q999>\t"Gone"@en`,
      ]);
    }
    if (/@en@schema:description/.test(query)) {
      return tsv("?item\t?description", [`${ENTITY}Q243>\t"tower in Paris"@en`]);
    }
    return tsv(query.includes("?code") ? "?item\t?code" : "?item\t?name", []);
  };
}

describe.skipIf(skipE2e)("notable-places publication", () => {
  it("publishes folded names and labels, and keeps them through a failed refresh", async () => {
    const pg = await startPostgis();
    try {
      const runtimeState = createNotablePlacesRuntimeState();
      const result = await buildNotablePlaces({
        sql: pg.sql,
        runtimeState,
        endpoint: "https://sparql.test",
        fetchImpl: fakeEndpoint(),
      });
      expect(result).toMatchObject({ placeCount: 1_202, minSitelinks: 8 });
      const kinds = await pg.sql.unsafe<{ qid: string; kind: string }[]>(
        `SELECT qid, kind FROM notable_places.places WHERE qid IN ('Q243','Q220','Q1429008') ORDER BY qid`,
      );
      // The crater is on the Moon; Rome is kept as a city.
      expect(kinds).toEqual([
        { qid: "Q220", kind: "settlement" },
        { qid: "Q243", kind: "place" },
      ]);

      const names = await pg.sql.unsafe<{ normalized: string; name: string }[]>(
        `SELECT normalized, name FROM notable_places.names WHERE qid = 'Q243' ORDER BY normalized`,
      );
      // The English label and the identical English alias are one name.
      expect(names).toEqual([
        { normalized: "eiffel tower", name: "Eiffel Tower" },
        { normalized: "eiffelturm", name: "Eiffelturm" },
        { normalized: "tour eiffel", name: "tour Eiffel" },
      ]);
      const labels = await pg.sql.unsafe<{ lang: string; name: string }[]>(
        `SELECT lang, name FROM notable_places.labels WHERE qid = 'Q243' ORDER BY lang`,
      );
      // Only the display languages keep a label of their own.
      expect(labels).toEqual([
        { lang: "de", name: "Eiffelturm" },
        { lang: "en", name: "Eiffel Tower" },
      ]);
      // Near spellings are found through the trigram index and edit distance.
      const near = await pg.sql.unsafe<{ qid: string }[]>(
        `SELECT qid FROM notable_places.names
          WHERE normalized % 'eifel tower'
            AND levenshtein_less_equal(normalized, 'eifel tower', 2) <= 2`,
      );
      expect(near).toEqual([{ qid: "Q243" }]);
      const [place] = await pg.sql.unsafe<{ fame: number }[]>(
        `SELECT fame FROM notable_places.places WHERE qid = 'Q243'`,
      );
      expect(Number(place?.fame)).toBeGreaterThan(0.9);
      const [orphan] = await pg.sql.unsafe<{ count: string }[]>(
        `SELECT COUNT(*)::TEXT AS count FROM notable_places.names WHERE qid = 'Q999'`,
      );
      expect(orphan?.count).toBe("0");

      await expect(
        buildNotablePlaces({
          sql: pg.sql,
          runtimeState,
          endpoint: "https://sparql.test",
          fetchImpl: fakeEndpoint(true),
        }),
      ).rejects.toThrow(/500/);
      const [state] = await pg.sql.unsafe<{ epoch: string; status: string; last_error: string }[]>(
        `SELECT epoch, status, last_error FROM notable_places.index_state`,
      );
      expect(state).toMatchObject({ epoch: result.epoch, status: "ready" });
      expect(state?.last_error).toMatch(/500/);
      const [staging] = await pg.sql.unsafe<{ exists: boolean }[]>(
        `SELECT to_regnamespace('notable_places__staging') IS NOT NULL AS exists`,
      );
      expect(staging?.exists).toBe(false);
    } finally {
      await pg.stop();
    }
  }, 180_000);
});
