import { describe, expect, it } from "vitest";
import {
  codesQuery,
  NOTABLE_EXCLUDED_CLASSES,
  NOTABLE_MIN_SETTLEMENT_SITELINKS,
  namesQuery,
  parseEntity,
  parseKind,
  parseLiteral,
  parsePoint,
  placesQuery,
  sparqlRows,
} from "../../src/jobs/notable-places/sparql.js";

function tsvResponse(body: string, status = 200): typeof fetch {
  return async () => new Response(body, { status });
}

async function collect(rows: AsyncGenerator<string[]>): Promise<string[][]> {
  const out: string[][] = [];
  for await (const row of rows) out.push(row);
  return out;
}

describe("notable-places SPARQL", () => {
  it("asks for places with enough sitelinks, and for cities known worldwide apart", () => {
    const query = placesQuery(8);
    const [places, settlements] = query.split("} UNION {");
    expect(places).toContain("FILTER(xsd:integer(?links) >= 8)");
    expect(places).toContain("MINUS { ?item wdt:P1082 ?population }");
    expect(places).toContain("MINUS { ?item wdt:P31/wdt:P279* wd:Q486972 }");
    expect(places).toContain('BIND("place" AS ?kind)');
    expect(settlements).toContain(
      `FILTER(xsd:integer(?links) >= ${NOTABLE_MIN_SETTLEMENT_SITELINKS})`,
    );
    expect(settlements).toContain("?item wdt:P31/wdt:P279* wd:Q486972 .");
    expect(settlements).toContain('BIND("settlement" AS ?kind)');
  });

  it("leaves out events and things that only have a coordinate, like languages", () => {
    const query = placesQuery(8);
    expect(query).toContain("MINUS { ?item wdt:P585 ?when }");
    for (const qid of NOTABLE_EXCLUDED_CLASSES) {
      expect(query).toContain(`MINUS { ?item wdt:P31/wdt:P279* wd:${qid} }`);
    }
    expect(NOTABLE_EXCLUDED_CLASSES).toContain("Q34770");
  });

  it("uses the per-language label predicates and refuses odd languages or properties", () => {
    expect(namesQuery("de", "label", 8)).toContain("?item @de@rdfs:label ?name");
    expect(namesQuery("fr", "alias", 8)).toContain("?item @fr@skos:altLabel ?name");
    expect(codesQuery("P238", 8)).toContain("?item wdt:P238 ?code");
    expect(() => namesQuery("de}; DROP", "label", 8)).toThrow(/invalid language/);
    expect(() => codesQuery("P238 }", 8)).toThrow(/invalid property/);
  });

  it("reads entities, literals and points as the endpoint writes them", () => {
    expect(parseEntity("<http://www.wikidata.org/entity/Q243>")).toBe("Q243");
    expect(parseEntity("Q243")).toBeUndefined();
    expect(parseLiteral('"Tour Eiffel"@fr')).toBe("Tour Eiffel");
    expect(parseLiteral('"say \\"hi\\"\\tthere"')).toBe('say "hi"\tthere');
    expect(parseLiteral('"191"^^<http://www.w3.org/2001/XMLSchema#int>')).toBe("191");
    expect(parseLiteral("191")).toBeUndefined();
    expect(parsePoint("POINT(2.294479 48.858296)")).toEqual([2.294479, 48.858296]);
    expect(
      parsePoint('"Point(-73.9 40.7)"^^<http://www.opengis.net/ont/geosparql#wktLiteral>'),
    ).toEqual([-73.9, 40.7]);
    expect(parsePoint("POINT(200 10)")).toBeUndefined();
    expect(parseKind('"settlement"')).toBe("settlement");
    expect(parseKind("place")).toBe("place");
    expect(parseKind('"village"')).toBeUndefined();
  });

  it("keeps points on Earth and drops those on the Moon or Mars", () => {
    expect(
      parsePoint(
        '"<http://www.wikidata.org/entity/Q405> Point(137.76 -1.85)"^^<http://www.opengis.net/ont/geosparql#wktLiteral>',
      ),
    ).toBeUndefined();
    expect(parsePoint("<http://www.wikidata.org/entity/Q2> POINT(2.29 48.86)")).toEqual([
      2.29, 48.86,
    ]);
  });

  it("streams rows after the header", async () => {
    const rows = await collect(
      sparqlRows("SELECT", {
        endpoint: "https://sparql.test",
        fetchImpl: tsvResponse(
          "?item\t?links\n<http://www.wikidata.org/entity/Q1>\t5\n<http://www.wikidata.org/entity/Q2>\t9\n",
        ),
      }),
    );
    expect(rows).toEqual([
      ["<http://www.wikidata.org/entity/Q1>", "5"],
      ["<http://www.wikidata.org/entity/Q2>", "9"],
    ]);
  });

  it("waits out a busy endpoint, then gives up", async () => {
    const statuses = [429, 503, 200];
    const fetchImpl: typeof fetch = async () => {
      const status = statuses.shift() ?? 200;
      return new Response(
        status === 200 ? "?item\n<http://www.wikidata.org/entity/Q1>\n" : "busy",
        {
          status,
        },
      );
    };
    const rows = await collect(
      sparqlRows("SELECT", { endpoint: "x", fetchImpl, retryDelaysMs: [0, 0, 0] }),
    );
    expect(rows).toEqual([["<http://www.wikidata.org/entity/Q1>"]]);

    await expect(
      collect(
        sparqlRows("SELECT", {
          endpoint: "x",
          fetchImpl: tsvResponse("busy", 429),
          retryDelaysMs: [0],
        }),
      ),
    ).rejects.toThrow(/429/);
  });

  it("fails on an error status or an error body sent as 200", async () => {
    await expect(
      collect(sparqlRows("SELECT", { endpoint: "x", fetchImpl: tsvResponse("broken", 500) })),
    ).rejects.toThrow(/500/);
    await expect(
      collect(
        sparqlRows("SELECT", {
          endpoint: "x",
          fetchImpl: tsvResponse('{\n "exception": "Operation timed out"\n}'),
        }),
      ),
    ).rejects.toThrow(/Operation timed out|exception/);
  });
});
