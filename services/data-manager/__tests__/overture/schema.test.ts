import { describe, expect, it } from "vitest";
import { assertValidOvertureSchema, buildSchemaDDL } from "../../src/jobs/overture/schema.js";

describe("assertValidOvertureSchema", () => {
  it("accepts 'overture_places'", () => {
    expect(() => assertValidOvertureSchema("overture_places")).not.toThrow();
  });

  it("rejects 'overture_buildings' (ODbL isolation)", () => {
    expect(() => assertValidOvertureSchema("overture_buildings")).toThrow(/overture_buildings/);
  });

  it("rejects 'overture_transportation' (ODbL isolation)", () => {
    expect(() => assertValidOvertureSchema("overture_transportation")).toThrow(
      /ODbL-licensed Overture theme/,
    );
  });

  it("rejects 'overture_divisions' (ODbL isolation)", () => {
    expect(() => assertValidOvertureSchema("overture_divisions")).toThrow(
      /ODbL-licensed Overture theme/,
    );
  });

  it("rejects 'overture_base' (ODbL isolation)", () => {
    expect(() => assertValidOvertureSchema("overture_base")).toThrow(
      /ODbL-licensed Overture theme/,
    );
  });

  it("rejects names that do not start with 'overture_'", () => {
    expect(() => assertValidOvertureSchema("public")).toThrow(/Invalid Overture schema name/);
    expect(() => assertValidOvertureSchema("gtfs_feed")).toThrow(/Invalid Overture schema name/);
    expect(() => assertValidOvertureSchema("")).toThrow(/Invalid Overture schema name/);
  });

  it("accepts 'overture_places__staging' (the ingest staging schema variant)", () => {
    expect(() => assertValidOvertureSchema("overture_places__staging")).not.toThrow();
  });

  it("rejects SQL-injection-style names", () => {
    expect(() => assertValidOvertureSchema('overture_places"; DROP TABLE x; --')).toThrow(
      /Invalid Overture schema name/,
    );
  });

  it("rejects names with uppercase letters", () => {
    expect(() => assertValidOvertureSchema("overture_Places")).toThrow(
      /Invalid Overture schema name/,
    );
  });
});

describe("current Overture taxonomy schema", () => {
  it("stores the upstream taxonomy structure and indexes its hierarchy", () => {
    const ddl = buildSchemaDDL("overture_places");
    expect(ddl).toContain("basic_category");
    expect(ddl).toContain("taxonomy_primary");
    expect(ddl).toContain("taxonomy_hierarchy");
    expect(ddl).toContain("taxonomy_alternates");
    expect(ddl).toContain("USING GIN (taxonomy_hierarchy)");
    expect(ddl).toContain("source_confidence DOUBLE PRECISION");
    expect(ddl).toContain("match_confidence  DOUBLE PRECISION NOT NULL");
    expect(ddl).toContain("evidence          JSONB NOT NULL");
    expect(ddl).toContain("PRIMARY KEY (osm_type, osm_id)");
    expect(ddl).toContain("gers_id           TEXT NOT NULL UNIQUE");
    expect(ddl).toContain('CREATE TABLE "overture_places".poi_conflation_candidate');
    expect(ddl).toContain('CREATE TABLE "overture_places".poi_conflation_link_next');
    expect(ddl).toContain('CREATE UNLOGGED TABLE "overture_places".poi_conflation_component');
    expect(ddl).toContain('CREATE TABLE "overture_places".conflation_state');
    expect(ddl).toContain("phase             TEXT NOT NULL DEFAULT 'extract'");
    expect(ddl).toContain("phase_durations_ms JSONB NOT NULL");
    expect(ddl).toContain("workspace_cleaned_at TIMESTAMPTZ");
    expect(ddl).toContain("release_files_pruned_at TIMESTAMPTZ");
    expect(ddl).toContain("'waiting_for_osm'");
    expect(ddl).toContain("h3_r8     TEXT NOT NULL");
    expect(ddl).not.toContain("confidence DOUBLE PRECISION NOT NULL");
    expect(ddl).not.toContain("openmapx_category");
    expect(ddl).not.toContain("opening_hours");
  });

  it("can defer Places indexes until after a bulk ingest", () => {
    const ddl = buildSchemaDDL("overture_places", { deferPlacesIndexes: true });
    expect(ddl).toContain('CREATE TABLE "overture_places".places');
    expect(ddl).not.toContain("idx_overture_geom");
    expect(ddl).not.toContain("idx_overture_taxonomy_hierarchy");
  });
});
