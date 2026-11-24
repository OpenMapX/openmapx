import type postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOvertureIngestSql,
  validateOvertureContributors,
} from "../../src/jobs/overture/ingest.js";

const mocks = { unsafe: vi.fn() };
const sql = { unsafe: mocks.unsafe } as unknown as postgres.Sql;

describe("Overture staged-release contributor validation", () => {
  beforeEach(() => {
    mocks.unsafe.mockReset();
  });

  it("accepts a staged release whose contributors all have manifest attribution", async () => {
    mocks.unsafe.mockResolvedValue([
      { dataset: "AllThePlaces" },
      { dataset: "Foursquare" },
      // A locale-aware database collation can place lowercase `meta` before
      // `Microsoft`; the pull contract uses JavaScript code-point ordering.
      { dataset: "meta" },
      { dataset: "Microsoft" },
      { dataset: "Overture" },
    ]);

    await expect(validateOvertureContributors(sql, "overture_places__staging")).resolves.toEqual([
      "AllThePlaces",
      "Foursquare",
      "Microsoft",
      "Overture",
      "meta",
    ]);
    expect(mocks.unsafe).toHaveBeenCalledWith(
      expect.stringContaining('FROM "overture_places__staging".places'),
      [],
    );
  });

  it("blocks activation when the staged release exposes an unknown contributor", async () => {
    mocks.unsafe.mockResolvedValue([
      { dataset: "Foursquare" },
      { dataset: "Unattributed New Dataset" },
    ]);

    await expect(validateOvertureContributors(sql, "overture_places__staging")).rejects.toThrow(
      /unsupported contributor dataset\(s\): Unattributed New Dataset/,
    );
  });
});

describe("buildOvertureIngestSql", () => {
  it("loads pre-installed extensions, computes H3 and SRID 4326 in DuckDB, and omits per-row sources_catalogue", () => {
    const query = buildOvertureIngestSql({
      databaseUrl: "postgresql://postgres:secret@postgis:5432/openmapx",
      stagingSchema: "overture_places__staging",
      parquetPath: "/data/overture/2026-11-18.0/europe-germany.parquet",
      release: "2026-11-18.0",
    });

    expect(query).not.toContain("INSTALL ");
    expect(query).toContain("LOAD postgres;");
    expect(query).toContain("LOAD spatial;");
    expect(query).toContain("LOAD h3;");
    expect(query).toContain("ST_SetCRS(geometry::GEOMETRY('OGC:CRS84'), 'EPSG:4326') AS geom,");
    expect(query).toContain(
      "CAST(h3_latlng_to_cell(ST_Y(geometry), ST_X(geometry), 8) AS BIGINT) AS h3_r8,",
    );
    expect(query).not.toContain("h3_latlng_to_cell_string");
    expect(query).not.toContain("sources_catalogue");
    expect(query).not.toContain("ALTER TABLE");
    expect(query).toContain('INSERT INTO pg."overture_places__staging".places');
  });
});
