import { describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core/server", () => ({
  findRepoRoot: () => "/repo",
}));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({
    list: () => [{ manifest: { id: "valhalla" } }, { manifest: { id: "osrm" } }],
  }),
}));

const {
  assertCountries,
  assertInsideRepo,
  assertKnownServiceIds,
  assertRegion,
  assertSlug,
  countriesSchema,
  optionalRegionSchema,
  regionSchema,
  rejectFlagLike,
  slugSchema,
} = await import("../admin-operation-input");

describe("region schema", () => {
  it("accepts ops-contract region ids and trims whitespace", () => {
    expect(regionSchema.parse(" europe/germany ")).toBe("europe/germany");
    expect(regionSchema.parse("germany")).toBe("germany");
  });

  it("rejects uppercase, flags, traversal, and empty input", () => {
    expect(regionSchema.safeParse("Europe/Germany").success).toBe(false);
    expect(regionSchema.safeParse("--region").success).toBe(false);
    expect(regionSchema.safeParse("a/../b").success).toBe(false);
    expect(regionSchema.safeParse("").success).toBe(false);
  });

  it("treats blank optional regions as absent", () => {
    expect(optionalRegionSchema.parse("")).toBeUndefined();
    expect(optionalRegionSchema.parse("   ")).toBeUndefined();
    expect(optionalRegionSchema.parse(undefined)).toBeUndefined();
    expect(optionalRegionSchema.parse("europe/france")).toBe("europe/france");
    expect(optionalRegionSchema.safeParse("-x").success).toBe(false);
  });
});

describe("countries schema", () => {
  it("normalises a comma-separated list to uppercase ISO codes", () => {
    expect(countriesSchema.parse("de, at ,ch")).toEqual(["DE", "AT", "CH"]);
    expect(countriesSchema.parse("")).toBeUndefined();
    expect(countriesSchema.parse(undefined)).toBeUndefined();
  });

  it("rejects names and flags", () => {
    expect(countriesSchema.safeParse("germany").success).toBe(false);
    expect(countriesSchema.safeParse("--countries=DE").success).toBe(false);
  });
});

describe("slug schema", () => {
  it("accepts data type ids and rejects flags or paths", () => {
    expect(slugSchema.parse("osm")).toBe("osm");
    expect(slugSchema.parse("all")).toBe("all");
    expect(slugSchema.safeParse("--all").success).toBe(false);
    expect(slugSchema.safeParse("/etc/passwd").success).toBe(false);
    expect(slugSchema.safeParse("").success).toBe(false);
  });
});

describe("imperative guards", () => {
  it("rejectFlagLike", () => {
    expect(() => rejectFlagLike("--preset=app", "x")).toThrow(/must not begin/);
    expect(() => rejectFlagLike("germany", "x")).not.toThrow();
  });

  it("assertSlug", () => {
    expect(() => assertSlug("app-api", "id")).not.toThrow();
    expect(() => assertSlug("foo bar", "id")).toThrow();
  });

  it("assertRegion", () => {
    expect(() => assertRegion("europe/germany")).not.toThrow();
    expect(() => assertRegion("../etc")).toThrow(/region/);
  });

  it("assertCountries", () => {
    expect(() => assertCountries("DE,CH")).not.toThrow();
    expect(() => assertCountries("germany")).toThrow();
  });

  it("assertInsideRepo", () => {
    expect(assertInsideRepo("infra/docker/feeds.json", "feedsFile")).toBe(
      "/repo/infra/docker/feeds.json",
    );
    expect(() => assertInsideRepo("/etc/passwd", "feedsFile")).toThrow(/inside the repo root/);
  });

  it("assertKnownServiceIds", () => {
    expect(() => assertKnownServiceIds(["valhalla"])).not.toThrow();
    expect(() => assertKnownServiceIds(["nope"])).toThrow(/Unknown serviceId/);
    expect(() => assertKnownServiceIds(["--preset"])).toThrow();
  });
});
