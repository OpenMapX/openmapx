import { describe, expect, it } from "vitest";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";

describe("search-index schema", () => {
  it("builds the independent staging schema with constraints", () => {
    const ddl = buildSearchIndexSchemaDDL("osm_search__staging");
    expect(ddl).toContain('CREATE SCHEMA "osm_search__staging"');
    expect(ddl).toContain("geom GEOMETRY(Point, 4326) NOT NULL");
    expect(ddl).not.toMatch(/\blat\b|\blng\b|GEOGRAPHY/);
    expect(ddl).toContain("authoritative_code");
    expect(ddl).toContain("current_fingerprint TEXT NOT NULL");
    expect(ddl).not.toContain("CREATE INDEX");
  });

  it("rejects arbitrary schema names", () => {
    expect(() => buildSearchIndexSchemaDDL("public" as never)).toThrow(/Invalid search index/);
  });

  it("builds bulk-load indexes separately", () => {
    const ddl = buildSearchIndexIndexesDDL("osm_search__staging");
    expect(ddl).toContain(
      'CREATE INDEX terms_normalized_term_idx ON "osm_search__staging".terms (normalized_term text_pattern_ops)',
    );
    expect(ddl).toContain(
      'CREATE INDEX places_geom_idx ON "osm_search__staging".places USING GIST (geom)',
    );
    // The text_pattern_ops index serves exact lookups too.
    expect(ddl.match(/CREATE INDEX/g)).toHaveLength(2);
  });
});
