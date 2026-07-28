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

  it("accepts 'overture_places__staging' (staging schema variant produced by applyOvertureSchema)", () => {
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
    expect(ddl).not.toContain("openmapx_category");
    expect(ddl).not.toContain("opening_hours");
  });
});
