import { describe, expect, it } from "vitest";
import { OVERTURE_QUALITY_BASELINE } from "../../../src/jobs/overture/eval/quality-baseline.js";
import { validateFusedOvertureQuality } from "../../../src/jobs/overture/eval/quality-gate.js";
import { buildSchemaDDL } from "../../../src/jobs/overture/schema.js";
import { startPostgis } from "../../helpers/postgis-testcontainer.js";

const skipE2e = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

describe.skipIf(skipE2e)("Overture fused quality gate in PostGIS", () => {
  it("counts OSM POIs on the case's box and none just outside it", async () => {
    const cafes = OVERTURE_QUALITY_BASELINE.find((entry) => entry.id === "aachen-centre-cafes");
    if (!cafes) throw new Error("missing Aachen café baseline");
    const baseline = { ...cafes, judgments: [], minimumResultCount: 0, minimumRelevantRecall: 0 };
    const { west, south, east, north } = baseline.bbox;
    const pg = await startPostgis();
    try {
      await pg.sql.unsafe(buildSchemaDDL("overture_places"));
      // A billionth of a degree is far below float4 precision, so a bounding
      // box overlap alone would still count the last café.
      const pois: [number, string, number, number][] = [
        [1, "Inside Café", (west + east) / 2, (south + north) / 2],
        [2, "Boundary Café", east, (south + north) / 2],
        [3, "Outside Café", (west + east) / 2, north + 1e-9],
      ];
      for (const [osmId, name, lng, lat] of pois) {
        await pg.sql.unsafe(
          `INSERT INTO overture_places.osm_pois (osm_type, osm_id, name, geom, h3_r8, category)
           VALUES ('node', $1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326),
                   x'881f1d4887fffff'::BIGINT, $5)`,
          [osmId, name, lng, lat, baseline.category],
        );
      }

      const result = await validateFusedOvertureQuality(
        pg.sql,
        "overture_places",
        baseline.region,
        [baseline],
      );
      expect(result.cases.map(({ resultCount }) => resultCount)).toEqual([2]);
    } finally {
      await pg.stop();
    }
  }, 120_000);
});
