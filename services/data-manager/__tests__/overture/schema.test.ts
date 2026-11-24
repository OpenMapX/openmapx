import { readFileSync } from "node:fs";
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

  it("accepts exactly the Overture Places names the database guard lets data-manager create", () => {
    const script = readFileSync(
      new URL("../../../postgis/scripts/sync-password.sh", import.meta.url),
      "utf8",
    );
    const pattern = /data_manager_schemas constant text := '([^']+)';/.exec(script)?.[1];
    if (!pattern) throw new Error("data_manager_schemas not found in the database guard");
    const guard = new RegExp(pattern.replaceAll("\\$", "$"));
    const accepted = ["overture_places", "overture_places__staging", "overture_places__previous"];
    for (const name of accepted) {
      expect(() => assertValidOvertureSchema(name)).not.toThrow();
      expect(guard.test(name)).toBe(true);
    }
    for (const name of [
      "overture_places_extra",
      "overture_places__staging2",
      "overture_embeddings",
      "overture_reuse_test",
      "overture_places__previous__staging",
    ]) {
      expect(() => assertValidOvertureSchema(name)).toThrow(/Invalid Overture schema name/);
    }
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
    expect(ddl).toContain('CONSTRAINT "poi_conflation_link_pkey" PRIMARY KEY (osm_type, osm_id)');
    expect(ddl).toContain('CONSTRAINT "poi_conflation_link_gers_id_key" UNIQUE (gers_id)');
    expect(ddl).toContain('CREATE TABLE "overture_places".poi_conflation_candidate');
    expect(ddl).toContain('CREATE TABLE "overture_places"."poi_conflation_link_next"');
    expect(ddl).toContain('CREATE UNLOGGED TABLE "overture_places".poi_conflation_component');
    expect(ddl).toContain('CREATE TABLE "overture_places".conflation_state');
    expect(ddl).toContain("geom              GEOMETRY(Point, 4326) NOT NULL");
    expect(ddl).toContain("h3_r8             BIGINT NOT NULL");
    expect(ddl).toContain("score_cursor_h3   BIGINT,");
    expect(ddl).toContain(
      "sources_catalogue JSONB NOT NULL CONSTRAINT conflation_state_sources_catalogue_check\n" +
        "        CHECK (jsonb_typeof(sources_catalogue) = 'array')",
    );
    expect(ddl).toContain("phase             TEXT NOT NULL DEFAULT 'extract'");
    expect(ddl).toContain("phase_durations_ms JSONB NOT NULL");
    expect(ddl).toContain("workspace_cleaned_at TIMESTAMPTZ");
    expect(ddl).toContain("release_files_pruned_at TIMESTAMPTZ");
    expect(ddl).toContain("'waiting_for_osm'");
    expect(ddl).toContain("h3_r8     BIGINT NOT NULL");
    expect(ddl.match(/\bsources_catalogue\b/g)).toHaveLength(2);
    expect(ddl).not.toContain("confidence DOUBLE PRECISION NOT NULL");
    expect(ddl).not.toContain("openmapx_category");
    expect(ddl).not.toContain("opening_hours");
  });

  it("keeps the link unique constraint without a duplicate index or a foreign key that would lock places", () => {
    const ddl = buildSchemaDDL("overture_places");
    for (const table of ["poi_conflation_link", "poi_conflation_link_next"]) {
      const definition = ddl.slice(ddl.indexOf(`CREATE TABLE "overture_places"."${table}" (`));
      expect(definition).toContain(`CONSTRAINT "${table}_gers_id_key" UNIQUE (gers_id),`);
      expect(definition.slice(0, definition.indexOf(");"))).not.toContain("REFERENCES");
    }
    expect(ddl).not.toMatch(
      /CREATE INDEX \w+ ON "overture_places"\.poi_conflation_link \(gers_id\)/,
    );
  });

  it("can defer Places indexes until after a bulk ingest", () => {
    const ddl = buildSchemaDDL("overture_places", { deferPlacesIndexes: true });
    expect(ddl).toContain('CREATE TABLE "overture_places".places');
    expect(ddl).not.toContain("places_geom_idx");
    expect(ddl).not.toContain("places_taxonomy_hierarchy_idx");
    expect(ddl).toContain("osm_pois_h3_r8_osm_type_osm_id_idx");
  });
});
