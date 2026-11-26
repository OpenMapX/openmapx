import { describe, expect, it } from "vitest";
import {
  approvedGrantsSchema,
  DATABASE_PRIVILEGE_PATTERN,
  DATABASE_ROLE_NAME_PATTERN,
  DATABASE_SCHEMA_NAME_PATTERN,
  isGrantId,
  isReservedDatabaseName,
  normalizeGrants,
} from "./grants";

describe("service grants", () => {
  it("accepts each grant form the platform derives", () => {
    for (const grant of [
      "host-path:/srv/gps:ro",
      "host-path:/:rw",
      "host-network",
      "device:/dev/ttyUSB0",
      "gpu",
      "capability:NET_ADMIN",
      "privileged",
      "logging",
      "platform-service:postgis",
      "reachable-by-platform",
      "peer-services",
      "database-role:openconditions_ingest",
    ])
      expect(isGrantId(grant), grant).toBe(true);
    expect(isGrantId(`host-path:/${"a".repeat(254)}:ro`)).toBe(true);
  });

  it("refuses a grant that could be read two ways", () => {
    for (const grant of [
      "host-path:/srv/a:b:ro",
      "host-path:/srv/../etc:ro",
      "host-path:srv:ro",
      "host-path:/srv/gps",
      "host-path:/srv/gps:rx",
      "host-path:/srv/$HOME:ro",
      "device:/etc/passwd",
      "capability:net_admin",
      "platform-service:Post_GIS",
      "database-role:Ingest",
      "database-role:ab",
      "database-role:",
      "gpu:all",
      "",
      7,
      null,
    ])
      expect(isGrantId(grant), String(grant)).toBe(false);
    expect(isGrantId(`host-path:/${"a".repeat(255)}:ro`)).toBe(false);
    expect(isGrantId(`device:/dev/${"a".repeat(251)}`)).toBe(false);
  });

  it("normalises to a sorted list without duplicates", () => {
    expect(normalizeGrants(["peer-services", "gpu", "peer-services"])).toEqual([
      "gpu",
      "peer-services",
    ]);
  });

  it("stores approvals as normalised lists per service", () => {
    expect(
      approvedGrantsSchema.safeParse({ "demo-engine": ["gpu", "peer-services"] }).success,
    ).toBe(true);
    expect(approvedGrantsSchema.safeParse({}).success).toBe(true);
    for (const value of [
      { "demo-engine": ["peer-services", "gpu"] },
      { "demo-engine": ["gpu", "gpu"] },
      { Demo: ["gpu"] },
      { "demo-engine": ["root"] },
      ["gpu"],
      null,
    ])
      expect(approvedGrantsSchema.safeParse(value).success).toBe(false);
    const lists = (services: number) =>
      Object.fromEntries(
        Array.from({ length: services }, (_, i) => [
          `svc-${i}`,
          normalizeGrants(
            Array.from({ length: 64 }, (_, j) => `capability:${"A".repeat(j + 1)}` as const),
          ),
        ]),
      );
    expect(approvedGrantsSchema.safeParse(lists(4)).success).toBe(true);
    expect(approvedGrantsSchema.safeParse(lists(5)).success).toBe(false);
  });

  it("fixes the database-request grammar", () => {
    for (const name of ["openconditions_ingest", "abc"])
      expect(name).toMatch(DATABASE_ROLE_NAME_PATTERN);
    for (const name of ["ab", "Ingest", "1abc", "a".repeat(64)])
      expect(name).not.toMatch(DATABASE_ROLE_NAME_PATTERN);
    for (const privilege of ["create-schema:conditions", "use-schema:extensions"])
      expect(privilege).toMatch(DATABASE_PRIVILEGE_PATTERN);
    for (const privilege of [
      "create-schema",
      "usage:extensions",
      "member-of:readers",
      "use-schema:Ext",
    ])
      expect(privilege).not.toMatch(DATABASE_PRIVILEGE_PATTERN);
    expect("c").toMatch(DATABASE_SCHEMA_NAME_PATTERN);
    for (const name of [
      "public",
      "tiles",
      "data_manager",
      "drizzle",
      "extensions",
      "information_schema",
      "postgres",
      "osm_search",
      "notable_places__staging",
      "ambient_places__previous",
      "overture_embeddings",
      "pg_catalog",
      "ext_demo",
      "openmapx_api",
    ])
      expect(isReservedDatabaseName(name), name).toBe(true);
    for (const name of ["conditions", "openconditions_ingest", "extension_data"])
      expect(isReservedDatabaseName(name), name).toBe(false);
  });
});
