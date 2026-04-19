import { describe, expect, it } from "vitest";
import { detectConsumesCycle, findByCapability, resolveRequirement } from "../services/resolver";
import type { LoadedService } from "../services/types";

function svc(id: string, opts: Partial<LoadedService["manifest"]> = {}): LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: `t/${id}`, tag: "latest", expose: [80] },
      ...opts,
    },
    directory: `/tmp/${id}`,
    isBuiltIn: true,
    enabled: true,
  };
}

describe("findByCapability", () => {
  it("returns enabled services that provide the capability", () => {
    const services = [
      svc("valhalla", { provides: ["routing-engine"] }),
      svc("osrm", { provides: ["routing-engine"] }),
      svc("nominatim", { provides: ["geocoder"] }),
    ];
    expect(findByCapability(services, "routing-engine").map((s) => s.manifest.id)).toEqual([
      "valhalla",
      "osrm",
    ]);
  });

  it("excludes disabled services", () => {
    const services = [
      { ...svc("valhalla", { provides: ["routing-engine"] }), enabled: false },
      svc("osrm", { provides: ["routing-engine"] }),
    ];
    expect(findByCapability(services, "routing-engine").map((s) => s.manifest.id)).toEqual([
      "osrm",
    ]);
  });
});

describe("resolveRequirement", () => {
  const services = [
    svc("valhalla", { provides: ["routing-engine"] }),
    svc("osrm", { provides: ["routing-engine"] }),
    svc("nominatim", { provides: ["geocoder"] }),
  ];

  it("resolves a specific service id", () => {
    const result = resolveRequirement(services, { service: "valhalla" });
    expect(result.satisfied).toBe(true);
    expect(result.match?.serviceId).toBe("valhalla");
    expect(result.match?.source).toBe("exact-service");
  });

  it("reports service-not-installed when specific id missing", () => {
    const result = resolveRequirement(services, { service: "missing" });
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("service-not-installed");
  });

  it("resolves a capability when exactly one provider exists", () => {
    const result = resolveRequirement(services, { capability: "geocoder" });
    expect(result.satisfied).toBe(true);
    expect(result.match?.serviceId).toBe("nominatim");
  });

  it("reports ambiguous when multiple providers exist with no binding", () => {
    const result = resolveRequirement(services, { capability: "routing-engine" });
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("ambiguous");
    expect(result.candidates?.sort()).toEqual(["osrm", "valhalla"]);
  });

  it("uses provided binding when capability has multiple providers", () => {
    const result = resolveRequirement(
      services,
      { capability: "routing-engine" },
      { bindings: new Map([["routing-engine", "osrm"]]) },
    );
    expect(result.satisfied).toBe(true);
    expect(result.match?.serviceId).toBe("osrm");
    expect(result.match?.source).toBe("capability");
  });

  it("reports no-providers when capability has none", () => {
    const result = resolveRequirement(services, { capability: "transit-engine" });
    expect(result.satisfied).toBe(false);
    expect(result.reason).toBe("no-providers");
  });

  it("treats Git URL as a service identifier (resolves by URL match)", () => {
    const community = svc("foo", { provides: [] });
    community.directory = "/tmp/.community/abc/foo";
    const result = resolveRequirement(
      [community],
      { service: "https://github.com/x/y" },
      { gitUrlBySlug: new Map([["foo", "https://github.com/x/y"]]) },
    );
    expect(result.satisfied).toBe(true);
    expect(result.match?.source).toBe("git-url");
  });
});

describe("detectConsumesCycle", () => {
  it("returns null for acyclic dependency graph", () => {
    const services = [
      svc("data", {
        provides: ["osm-data"],
        produces: [{ type: "osm-data", sourceDir: "data/osm" }],
      }),
      svc("valhalla", {
        provides: ["routing-engine"],
        consumes: [{ type: "osm-data", mountAt: "/custom_files", required: true }],
      }),
    ];
    expect(detectConsumesCycle(services)).toBeNull();
  });

  it("detects a cycle and returns the offending ids", () => {
    const a = svc("a", {
      provides: ["x"],
      consumes: [{ type: "y", mountAt: "/y", required: true }],
      produces: [{ type: "x", sourceDir: "data/a" }],
    });
    const b = svc("b", {
      provides: ["y"],
      consumes: [{ type: "x", mountAt: "/x", required: true }],
      produces: [{ type: "y", sourceDir: "data/b" }],
    });
    const cycle = detectConsumesCycle([a, b]);
    expect(cycle).not.toBeNull();
    expect(cycle?.sort()).toEqual(["a", "b"]);
  });
});

describe("findByCapability — structured `provides` form", () => {
  it("matches a service whose provides entry uses the structured form", () => {
    const services = [
      svc("valhalla-eu", {
        provides: [
          {
            capability: "routing-engine",
            metadata: { region: "europe", bbox: [-25, 35, 45, 72] },
          },
        ],
      }),
      svc("nominatim", { provides: ["geocoder"] }),
    ];
    const result = findByCapability(services, "routing-engine").map((s) => s.manifest.id);
    expect(result).toEqual(["valhalla-eu"]);
  });

  it("matches across mixed bare-string and structured-form providers", () => {
    const services = [
      svc("valhalla-eu", {
        provides: [{ capability: "routing-engine", metadata: { region: "europe" } }],
      }),
      svc("osrm", { provides: ["routing-engine"] }),
    ];
    const result = findByCapability(services, "routing-engine")
      .map((s) => s.manifest.id)
      .sort();
    expect(result).toEqual(["osrm", "valhalla-eu"]);
  });
});
