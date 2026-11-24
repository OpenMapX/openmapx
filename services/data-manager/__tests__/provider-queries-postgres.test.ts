import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { latLngToCell } from "h3-js";
import { describe, expect, it } from "vitest";
import { createNotablePlacesSuggestionProvider } from "../../../integrations/search-notable-places/provider.js";
import { createOsmAliasSuggestionProvider } from "../../../integrations/search-osm-aliases/provider.js";
import {
  buildNotablePlacesFinishDDL,
  buildNotablePlacesSchemaDDL,
} from "../src/jobs/notable-places/schema.js";
import { NOTABLE_DISPLAY_LANGUAGES } from "../src/jobs/notable-places/sparql.js";
import {
  type ConflationScoreCursor,
  scoreOvertureCandidates,
} from "../src/jobs/overture/conflate.js";
import { h3CellToBigint } from "../src/jobs/overture/h3.js";
import { buildSchemaDDL } from "../src/jobs/overture/schema.js";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../src/jobs/search-index/schema.js";
import { type PostgisFixture, startPostgis } from "./helpers/postgis-testcontainer.js";

const EXPECTED = new URL("./provider-queries.expected.json", import.meta.url);
const RELEASE = "2026-01-01.0";

interface SearchPlace {
  osmType: "node" | "way" | "relation";
  osmId: string;
  name: string;
  lat: number;
  lng: number;
  category: string | null;
  tags: Record<string, string>;
  importance: number;
  terms: { normalized: string; display: string; kind: string; namespace: string | null }[];
}

const SEARCH_PLACES: SearchPlace[] = [
  {
    osmType: "way",
    osmId: "26442131",
    name: "Frankfurt Airport",
    lat: 50.0379,
    lng: 8.5622,
    category: "aeroway/aerodrome",
    tags: { wikidata: "Q46033", iata: "FRA" },
    importance: 0.95,
    terms: [{ normalized: "fra", display: "FRA", kind: "authoritative_code", namespace: "iata" }],
  },
  {
    osmType: "node",
    osmId: "9007199254740993",
    name: "Freiburg Rathaus",
    lat: 47.9959,
    lng: 7.8494,
    category: "amenity/townhall",
    tags: {},
    importance: 0.4,
    terms: [{ normalized: "fra", display: "FRA", kind: "generated_acronym", namespace: null }],
  },
  {
    osmType: "node",
    osmId: "501",
    name: "Fachhochschule Rhein Aachen",
    lat: 50.7587,
    lng: 6.0837,
    category: "amenity/university",
    tags: {},
    importance: 0.5,
    terms: [{ normalized: "fra", display: "FRA", kind: "generated_acronym", namespace: null }],
  },
  {
    osmType: "relation",
    osmId: "62428",
    name: "Rheinisch-Westfälische Technische Hochschule Aachen",
    lat: 50.7779,
    lng: 6.0775,
    category: "amenity/university",
    tags: { wikidata: "Q273263", short_name: "RWTH" },
    importance: 0.85,
    terms: [
      { normalized: "rwth", display: "RWTH", kind: "explicit_alias", namespace: "short_name" },
      {
        normalized: "rwth aachen",
        display: "RWTH Aachen",
        kind: "explicit_alias",
        namespace: "alt_name",
      },
    ],
  },
  {
    osmType: "node",
    osmId: "77",
    name: "Klinikum Aachen",
    lat: 50.7767,
    lng: 6.0434,
    category: "amenity/hospital",
    tags: { ref: "UKA" },
    importance: 0.6,
    terms: [{ normalized: "uka", display: "UKA", kind: "explicit_reference", namespace: "ref" }],
  },
  {
    osmType: "node",
    osmId: "78",
    name: "Unterkunft Ahrweiler",
    lat: 50.5431,
    lng: 7.1127,
    category: "tourism/hostel",
    tags: { ref: "UKA-2" },
    importance: 0.6,
    terms: [
      { normalized: "uka 2", display: "UKA 2", kind: "explicit_reference", namespace: "ref" },
    ],
  },
  {
    osmType: "node",
    osmId: "79",
    name: "Universitätsklinikum Augsburg",
    lat: 48.3836,
    lng: 10.8406,
    category: "amenity/hospital",
    tags: {},
    importance: 0.6,
    terms: [{ normalized: "uka", display: "UKA", kind: "generated_acronym", namespace: null }],
  },
];

interface NotablePlace {
  qid: string;
  kind: "place" | "settlement";
  lat: number;
  lng: number;
  sitelinks: number;
  fame: number;
  names: { lang: string; kind: "label" | "alias"; name: string; normalized: string }[];
  description?: string;
}

const NOTABLE_PLACES: NotablePlace[] = [
  {
    qid: "Q243",
    kind: "place",
    lat: 48.8584,
    lng: 2.2945,
    sitelinks: 180,
    fame: 0.98,
    names: [
      { lang: "en", kind: "label", name: "Eiffel Tower", normalized: "eiffel tower" },
      { lang: "de", kind: "label", name: "Eiffelturm", normalized: "eiffelturm" },
      { lang: "fr", kind: "label", name: "tour Eiffel", normalized: "tour eiffel" },
    ],
    description: "tower in Paris",
  },
  {
    qid: "Q19675",
    kind: "place",
    lat: 48.8611,
    lng: 2.3364,
    sitelinks: 200,
    fame: 0.99,
    names: [
      { lang: "en", kind: "label", name: "Louvre", normalized: "louvre" },
      { lang: "en", kind: "alias", name: "Louvre Museum", normalized: "louvre museum" },
    ],
    description: "art museum in Paris",
  },
  {
    qid: "Q1001",
    kind: "place",
    lat: 52.5163,
    lng: 13.3777,
    sitelinks: 20,
    fame: 0.35,
    names: [{ lang: "de", kind: "label", name: "Louvre Bar", normalized: "louvre bar" }],
  },
  {
    qid: "Q1002",
    kind: "place",
    lat: 41.9022,
    lng: 12.4539,
    sitelinks: 150,
    fame: 0.9,
    names: [{ lang: "en", kind: "label", name: "Romanesque Hall", normalized: "romanesque hall" }],
  },
  {
    qid: "Q1003",
    kind: "place",
    lat: 52.52,
    lng: 13.405,
    sitelinks: 30,
    fame: 0.5,
    names: [{ lang: "de", kind: "label", name: "Romantikhaus", normalized: "romantikhaus" }],
  },
  {
    qid: "Q220",
    kind: "settlement",
    lat: 41.8933,
    lng: 12.4828,
    sitelinks: 300,
    fame: 1,
    names: [
      { lang: "en", kind: "label", name: "Rome", normalized: "rome" },
      { lang: "it", kind: "label", name: "Roma", normalized: "roma" },
    ],
  },
];

interface OsmPoi {
  osmType: "node" | "way";
  osmId: number;
  name: string;
  lat: number;
  lng: number;
  category: string | null;
  tags: Record<string, string>;
}

interface OverturePlace {
  gersId: string;
  name: string;
  lat: number;
  lng: number;
  basicCategory: string | null;
  confidence: number;
}

const OSM_POIS: OsmPoi[] = [
  {
    osmType: "node",
    osmId: 11,
    name: "Café Kittel",
    lat: 50.7754,
    lng: 6.0841,
    category: "cafe",
    tags: { amenity: "cafe", "addr:street": "Pontstraße", "addr:housenumber": "39" },
  },
  {
    osmType: "way",
    osmId: 12,
    name: "Aachener Dom",
    lat: 50.7746,
    lng: 6.0838,
    category: "place_of_worship",
    tags: { amenity: "place_of_worship", wikidata: "Q4176" },
  },
  {
    osmType: "node",
    osmId: 13,
    name: "Apotheke am Markt",
    lat: 50.7762,
    lng: 6.0838,
    category: "pharmacy",
    tags: { amenity: "pharmacy", phone: "+49 241 123456" },
  },
  {
    osmType: "node",
    osmId: 14,
    name: "Bäckerei Moss",
    lat: 52.5208,
    lng: 13.4094,
    category: "bakery",
    tags: { shop: "bakery", website: "https://moss.example" },
  },
  {
    osmType: "node",
    osmId: 15,
    name: "Elisenbrunnen",
    lat: 50.7737,
    lng: 6.0861,
    category: null,
    tags: { amenity: "fountain" },
  },
];

const OVERTURE_PLACES: OverturePlace[] = [
  {
    gersId: "gers-kittel",
    name: "Cafe Kittel",
    lat: 50.77542,
    lng: 6.08412,
    basicCategory: "cafe",
    confidence: 0.9,
  },
  {
    gersId: "gers-dom",
    name: "Aachen Cathedral",
    lat: 50.77461,
    lng: 6.08383,
    basicCategory: "church",
    confidence: 0.95,
  },
  {
    gersId: "gers-apotheke",
    name: "Apotheke am Markt",
    lat: 50.77625,
    lng: 6.08379,
    basicCategory: "pharmacy",
    confidence: 0.8,
  },
  {
    gersId: "gers-moss",
    name: "Moss Bakery",
    lat: 52.52079,
    lng: 13.40941,
    basicCategory: "bakery",
    confidence: 0.7,
  },
];

async function seedSearchIndex(pg: PostgisFixture): Promise<void> {
  await pg.sql.unsafe(buildSearchIndexSchemaDDL("osm_search"));
  for (const place of SEARCH_PLACES) {
    await pg.sql.unsafe(
      `INSERT INTO osm_search.places (osm_type, osm_id, name, geom, category, tags, importance)
       VALUES ($1, $2::BIGINT, $3, ST_Point($4, $5, 4326), $6, $7::TEXT::JSONB, $8)`,
      [
        place.osmType,
        place.osmId,
        place.name,
        place.lng,
        place.lat,
        place.category,
        JSON.stringify(place.tags),
        place.importance,
      ],
    );
    for (const term of place.terms)
      await pg.sql.unsafe(
        `INSERT INTO osm_search.terms (osm_type, osm_id, normalized_term, display_value, kind, namespace)
         VALUES ($1, $2::BIGINT, $3, $4, $5, $6)`,
        [place.osmType, place.osmId, term.normalized, term.display, term.kind, term.namespace],
      );
  }
  await pg.sql.unsafe(buildSearchIndexIndexesDDL("osm_search"));
  await pg.sql.unsafe(
    `INSERT INTO osm_search.index_state (region, source_path, source_fingerprint, current_fingerprint,
       epoch, status, started_at, published_at, updated_at)
     VALUES ('germany', '/fixture.osm.pbf', 'f', 'f', 'epoch-1', 'ready', now(), now(), now())`,
  );
}

async function seedNotablePlaces(pg: PostgisFixture): Promise<void> {
  await pg.sql.unsafe(buildNotablePlacesSchemaDDL("notable_places"));
  for (const place of NOTABLE_PLACES) {
    await pg.sql.unsafe(
      `INSERT INTO notable_places.places (qid, kind, geom, sitelinks, fame)
       VALUES ($1, $2, ST_Point($3, $4, 4326), $5, $6)`,
      [place.qid, place.kind, place.lng, place.lat, place.sitelinks, place.fame],
    );
    for (const name of place.names)
      await pg.sql.unsafe(
        `INSERT INTO notable_places.fetched_names (qid, lang, kind, name, normalized) VALUES ($1, $2, $3, $4, $5)`,
        [place.qid, name.lang, name.kind, name.name, name.normalized],
      );
    if (place.description)
      await pg.sql.unsafe(
        `INSERT INTO notable_places.descriptions (qid, lang, description) VALUES ($1, 'en', $2)`,
        [place.qid, place.description],
      );
  }
  await pg.sql.unsafe(buildNotablePlacesFinishDDL("notable_places", NOTABLE_DISPLAY_LANGUAGES));
  await pg.sql.unsafe(
    `INSERT INTO notable_places.index_state (source, min_sitelinks, epoch, status, started_at, published_at, updated_at)
     VALUES ('wikidata', 10, 'epoch-1', 'ready', now(), now(), now())`,
  );
}

async function seedOverture(pg: PostgisFixture, extraOsmPois: OsmPoi[] = []): Promise<void> {
  await pg.sql.unsafe(buildSchemaDDL("overture_places"));
  for (const place of OVERTURE_PLACES)
    await pg.sql.unsafe(
      `INSERT INTO overture_places.places (gers_id, name, geom, h3_r8, basic_category, confidence, release)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5::BIGINT, $6, $7, $8)`,
      [
        place.gersId,
        place.name,
        place.lng,
        place.lat,
        h3CellToBigint(latLngToCell(place.lat, place.lng, 8)),
        place.basicCategory,
        place.confidence,
        RELEASE,
      ],
    );
  const pois = [...OSM_POIS, ...extraOsmPois];
  await pg.sql.unsafe(
    `INSERT INTO overture_places.osm_pois (osm_type, osm_id, name, geom, h3_r8, category, tags)
     SELECT osm_type, osm_id, name, ST_Point(lng, lat, 4326), h3_r8, category, tags
       FROM UNNEST($1::TEXT[], $2::BIGINT[], $3::TEXT[], $4::DOUBLE PRECISION[],
         $5::DOUBLE PRECISION[], $6::BIGINT[], $7::TEXT[], $8::TEXT[]::JSONB[])
         AS poi (osm_type, osm_id, name, lat, lng, h3_r8, category, tags)`,
    [
      pois.map((poi) => poi.osmType),
      pois.map((poi) => String(poi.osmId)),
      pois.map((poi) => poi.name),
      pois.map((poi) => poi.lat),
      pois.map((poi) => poi.lng),
      pois.map((poi) => h3CellToBigint(latLngToCell(poi.lat, poi.lng, 8))),
      pois.map((poi) => poi.category),
      pois.map((poi) => JSON.stringify(poi.tags)),
    ],
  );
}

const signal = () => ({
  signal: new AbortController().signal,
  deadlineAt: Number.POSITIVE_INFINITY,
});

function context(pg: PostgisFixture) {
  return createMockIntegrationContext({
    db: {
      execute: async <T>(query: string, params?: unknown[]) =>
        (await pg.sql.unsafe(query, params as never[])) as unknown as T,
    },
  });
}

async function candidates(pg: PostgisFixture) {
  return pg.sql.unsafe(
    `SELECT osm_type, osm_id::TEXT AS osm_id, gers_id, source_confidence, match_confidence,
            distance_m, method, evidence, release
       FROM overture_places.poi_conflation_candidate
      ORDER BY osm_type, osm_id, gers_id`,
  );
}

/** Attribution snapshots are compared by digest to keep the recording readable. */
function digestContributors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(digestContributors);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === "contributors"
          ? `sha256:${createHash("sha256").update(JSON.stringify(entry)).digest("hex")}`
          : digestContributors(entry),
      ]),
    );
  return value;
}

/** Orders the scoring keyset the way the database orders it. */
function compareCursor(a: ConflationScoreCursor, b: ConflationScoreCursor): number {
  const cell = (value: string | null) => BigInt(value === null ? -1 : `0x${value}`);
  const byCell = cell(a.h3) - cell(b.h3);
  if (byCell !== 0n) return byCell < 0n ? -1 : 1;
  if (a.osmType !== b.osmType) return a.osmType < b.osmType ? -1 : 1;
  const byId = BigInt(a.osmId) - BigInt(b.osmId);
  return byId === 0n ? 0 : byId < 0n ? -1 : 1;
}

/**
 * The search, notable-places and conflation queries must return the same
 * results whatever data-manager's storage of points and H3 cells is. The
 * expected output was recorded before a storage change and must still match
 * after it.
 */
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "provider queries on a fixed fixture",
  () => {
    it("return the recorded suggestions and conflation candidates", async () => {
      const pg = await startPostgis();
      try {
        await seedSearchIndex(pg);
        await seedNotablePlaces(pg);
        await seedOverture(pg);
        const ctx = context(pg);
        const aliases = createOsmAliasSuggestionProvider(ctx);
        const notable = createNotablePlacesSuggestionProvider(ctx);
        const search = async (
          provider: typeof aliases,
          query: string,
          proximity?: [number, number],
        ) =>
          (
            await provider.searchSuggestions(
              { query, lang: "en", limit: 8, ...(proximity ? { proximity } : {}) },
              signal(),
            )
          ).suggestions;

        const aachen: [number, number] = [6.0839, 50.7753];
        const augsburg: [number, number] = [10.8978, 48.3705];
        const paris: [number, number] = [2.3522, 48.8566];
        const berlin: [number, number] = [13.405, 52.52];
        const actual = {
          aliases: {
            upperFra: await search(aliases, "FRA"),
            lowerFraAachen: await search(aliases, "fra", aachen),
            lowerFraNoProximity: await search(aliases, "fra"),
            ukaAachen: await search(aliases, "uka", aachen),
            ukaAugsburg: await search(aliases, "uka", augsburg),
            rwthPrefix: await search(aliases, "rwth a"),
          },
          notable: {
            eiffelExact: await search(notable, "Eiffel Tower"),
            eiffelSlip: await search(notable, "eifel tower"),
            louvreParis: await search(notable, "louvre", paris),
            louvreBerlin: await search(notable, "louvre", berlin),
            romBerlin: await search(notable, "rom", berlin),
            romeNoProximity: await search(notable, "rome"),
          },
          conflation: {} as Record<string, unknown>,
        };

        const fresh = await scoreOvertureCandidates({
          sql: pg.sql,
          region: "germany",
          release: RELEASE,
        });
        actual.conflation.fresh = { result: fresh, candidates: await candidates(pg) };
        const order = await pg.sql.unsafe<{ osm_type: string; osm_id: string }[]>(
          `SELECT osm_type, osm_id::TEXT AS osm_id FROM overture_places.osm_pois ORDER BY h3_r8, osm_type, osm_id`,
        );
        actual.conflation.keysetOrder = order.map((row) => `${row.osm_type}/${row.osm_id}`);
        const resumed: unknown[] = [];
        for (const poi of OSM_POIS) {
          await pg.sql.unsafe(`TRUNCATE overture_places.poi_conflation_candidate`);
          const cursor = {
            h3: latLngToCell(poi.lat, poi.lng, 8),
            osmType: poi.osmType,
            osmId: String(poi.osmId),
          };
          const result = await scoreOvertureCandidates({
            sql: pg.sql,
            region: "germany",
            release: RELEASE,
            resume: { cursor, processed: 0, candidates: 0 },
          });
          resumed.push({
            after: `${poi.osmType}/${poi.osmId}`,
            result,
            candidates: (await candidates(pg)).map((row) => `${row.osm_type}/${row.osm_id}`),
          });
        }
        actual.conflation.resumed = resumed;

        const recorded = digestContributors(JSON.parse(JSON.stringify(actual)));
        if (process.env.OPENMAPX_PROVIDER_QUERIES_FIXTURE_PATH) {
          await writeFile(
            process.env.OPENMAPX_PROVIDER_QUERIES_FIXTURE_PATH,
            `${JSON.stringify(recorded, null, 2)}\n`,
          );
        }
        expect(recorded).toEqual(JSON.parse(await readFile(EXPECTED, "utf8")));
      } finally {
        await pg.stop();
      }
    }, 180_000);

    it("pages the conflation keyset in cell order without skipping or repeating a POI", async () => {
      const pg = await startPostgis();
      try {
        // Enough POIs for three pages, spread over many cells, with several
        // POIs sharing a cell so the type and id break ties.
        const extra: OsmPoi[] = Array.from({ length: 4_500 }, (_, i) => {
          const spot = Math.floor(i / 3);
          return {
            osmType: i % 3 === 0 ? "way" : "node",
            osmId: 1_000 + i,
            name: `Fixture ${i}`,
            lat: 47 + ((spot * 7919) % 500) / 100,
            lng: 6 + ((spot * 104_729) % 900) / 100,
            category: null,
            tags: {},
          };
        });
        await seedOverture(pg, extra);
        const cursors: ConflationScoreCursor[] = [];
        const result = await scoreOvertureCandidates({
          sql: pg.sql,
          region: "germany",
          release: RELEASE,
          onCheckpoint: async (_processed, _candidates, cursor) => {
            cursors.push(cursor);
          },
        });
        const total = OSM_POIS.length + extra.length;
        expect(result.processed).toBe(total);
        expect(cursors).toHaveLength(Math.ceil(total / 2_000));
        for (let i = 1; i < cursors.length; i++) {
          const [previous, current] = [cursors[i - 1], cursors[i]];
          if (!previous || !current) throw new Error("missing cursor");
          expect(compareCursor(previous, current)).toBe(-1);
        }
        // Resuming from the first page's cursor scores exactly the rest.
        const first = cursors[0];
        if (!first) throw new Error("missing cursor");
        const pages: [string, unknown[]][] = [];
        const recording = {
          unsafe: (query: string, params?: unknown[]) => {
            if (query.includes("osm_pois")) pages.push([query, params ?? []]);
            return pg.sql.unsafe(query, params as never[]);
          },
        } as unknown as typeof pg.sql;
        const rest = await scoreOvertureCandidates({
          sql: recording,
          region: "germany",
          release: RELEASE,
          resume: { cursor: first, processed: 0, candidates: 0 },
        });
        expect(rest.processed).toBe(total - 2_000);
        expect(rest.cursor).toEqual(cursors.at(-1));
        // A page orders by the bigint cell, not by its text, and can walk the
        // keyset index in order.
        const [pageQuery, pageParams] = pages[0] ?? ["", []];
        const plan = await pg.sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL enable_seqscan = off`);
          await tx.unsafe(`SET LOCAL enable_bitmapscan = off`);
          await tx.unsafe(`SET LOCAL enable_sort = off`);
          return tx.unsafe<{ "QUERY PLAN": string }[]>(
            `EXPLAIN ${pageQuery}`,
            pageParams as never[],
          );
        });
        const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
        expect(text).toContain("Index Scan using osm_pois_h3_r8_osm_type_osm_id_idx");
        expect(text).not.toContain("Sort");
        expect(text).not.toContain("(h3_r8)::text");
      } finally {
        await pg.stop();
      }
    }, 180_000);
  },
);
