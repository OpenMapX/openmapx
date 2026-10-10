import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAmbientPlaces } from "../../src/jobs/ambient-places/build.js";
import { buildOsmSearchIndex } from "../../src/jobs/search-index/build.js";
import { featureToSearchPlace } from "../../src/jobs/search-index/extract.js";
import { StateStore } from "../../src/state.js";
import { startPostgis } from "../helpers/postgis-testcontainer.js";
import corpus from "./landmark-corpus.json";

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "OSM extraction/index/publication boundary",
  () => {
    it("stores object tags and publishes source-backed landmarks while excluding access/closure", async () => {
      const pg = await startPostgis();
      const dir = mkdtempSync(join(tmpdir(), "ambient-index-"));
      try {
        const path = join(dir, "fixture.pbf");
        writeFileSync(path, "fixture");
        const store = new StateStore(dir);
        store.upsert({
          type: "osm-pbf",
          id: "europe/germany",
          region: "europe/germany",
          path,
          sizeBytes: 7,
          downloadedAt: new Date().toISOString(),
        });
        const base = featureToSearchPlace(corpus.cases[0].feature)!;
        const records = [
          base,
          { ...base, osmId: "990001", tags: { ...base.tags, access: "private" } },
          { ...base, osmId: "990002", tags: { ...base.tags, disused: "yes" } },
        ];
        await buildOsmSearchIndex({
          region: "europe/germany",
          dataDir: dir,
          store,
          sql: pg.sql,
          runtimeState: { building: false, failure: null },
          dependencies: {
            extract: async ({ onBatch }) => {
              await onBatch(records);
              return { emitted: 3, extracted: 3 };
            },
          },
        });
        const rows = await pg.sql.unsafe(
          `SELECT jsonb_typeof(tags) AS kind,tags->>'basilica' AS basilica FROM osm_search.places`,
        );
        expect(rows.every((r) => r.kind === "object")).toBe(true);
        expect(rows[0].basilica).toBe("minor");
        const manifest = await buildAmbientPlaces(pg.sql, {
          name: "Neuss",
          bounds: [6.58, 50.89, 7.07, 51.31],
        });
        expect(manifest.placeCount).toBe(1);
        expect(manifest.policyVersion).toBe(2);
        expect(
          await pg.sql.unsafe(
            `SELECT id,min_zoom FROM ambient_places.features WHERE generation=$1`,
            [manifest.generation],
          ),
        ).toMatchObject([{ id: "osm:way/28562993", min_zoom: 14 }]);
      } finally {
        await pg.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
