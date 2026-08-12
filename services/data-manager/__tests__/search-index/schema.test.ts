import { describe, expect, it } from "vitest";
import {
  buildSearchIndexIndexesDDL,
  buildSearchIndexSchemaDDL,
} from "../../src/jobs/search-index/schema.js";

describe("search-index schema", () => {
  it("builds the independent staging schema with constraints", () => {
    const ddl = buildSearchIndexSchemaDDL("osm_search__staging");
    expect(ddl).toContain('CREATE SCHEMA "osm_search__staging"');
    expect(ddl).toContain("GEOGRAPHY(POINT, 4326)");
    expect(ddl).toContain("authoritative_code");
    expect(ddl).toContain("current_fingerprint TEXT NOT NULL");
    expect(ddl).not.toContain("CREATE INDEX idx_osm_search_terms_prefix");
  });

  it("rejects arbitrary schema names", () => {
    expect(() => buildSearchIndexSchemaDDL("public" as never)).toThrow(/Invalid search index/);
  });

  it("builds bulk-load indexes separately", () => {
    const ddl = buildSearchIndexIndexesDDL("osm_search__staging");
    expect(ddl).toContain("text_pattern_ops");
    expect(ddl).toContain("USING GIST (geom)");
  });
});
