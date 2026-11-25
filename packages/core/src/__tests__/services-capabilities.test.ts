import { describe, expect, it } from "vitest";
import {
  capabilityNameErrors,
  checkCapabilityName,
  WELL_KNOWN_CAPABILITIES,
  WELL_KNOWN_DATA_TYPES,
} from "../services/capabilities";
import { validateServiceManifest } from "../services/manifest-schema";

describe("checkCapabilityName", () => {
  it("recognises every well-known capability", () => {
    for (const name of WELL_KNOWN_CAPABILITIES) {
      const result = checkCapabilityName(name, "capability");
      expect(result.ok).toBe(true);
      expect(result.wellKnown).toBe(true);
      expect(result.namespaced).toBe(false);
    }
  });

  it("recognises every well-known data type", () => {
    for (const name of WELL_KNOWN_DATA_TYPES) {
      const result = checkCapabilityName(name, "data-type");
      expect(result.ok).toBe(true);
      expect(result.wellKnown).toBe(true);
    }
  });

  it("accepts namespaced names like acme/routing-engine", () => {
    const result = checkCapabilityName("acme/routing-engine", "capability");
    expect(result.ok).toBe(true);
    expect(result.wellKnown).toBe(false);
    expect(result.namespaced).toBe(true);
  });

  it("rejects unrecognised, non-namespaced names", () => {
    const result = checkCapabilityName("custom-thing", "capability");
    expect(result.ok).toBe(false);
    expect(result.wellKnown).toBe(false);
    expect(result.namespaced).toBe(false);
  });

  it("rejects malformed namespaced names (uppercase, multiple slashes, leading hyphen)", () => {
    expect(checkCapabilityName("Acme/foo", "capability").namespaced).toBe(false);
    expect(checkCapabilityName("acme/foo/bar", "capability").namespaced).toBe(false);
    expect(checkCapabilityName("-acme/foo", "capability").namespaced).toBe(false);
    expect(checkCapabilityName("acme/-foo", "capability").namespaced).toBe(false);
  });

  it("treats capability and data-type as separate namespaces (a name well-known on one side may be unrecognised on the other)", () => {
    // "osm-pbf" is a data type, not a capability.
    expect(checkCapabilityName("osm-pbf", "data-type").wellKnown).toBe(true);
    expect(checkCapabilityName("osm-pbf", "capability").wellKnown).toBe(false);
    // "routing-engine" is a capability, not a data type.
    expect(checkCapabilityName("routing-engine", "capability").wellKnown).toBe(true);
    expect(checkCapabilityName("routing-engine", "data-type").wellKnown).toBe(false);
  });
});

describe("capabilityNameErrors", () => {
  it("returns no errors for an all-well-known manifest", () => {
    expect(
      capabilityNameErrors({
        provides: ["routing-engine"],
        produces: [{ type: "osm-pbf" }],
        consumes: [{ type: "gtfs" }],
      }),
    ).toEqual([]);
  });

  it("returns no errors for a namespaced community capability", () => {
    expect(
      capabilityNameErrors({
        provides: ["acme/super-router"],
        produces: [{ type: "acme/proprietary-blob" }],
      }),
    ).toEqual([]);
  });

  it("names the path of an unrecognised capability", () => {
    const errors = capabilityNameErrors({ provides: ["routing-engine", "totally-made-up"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^provides\[1\]: "totally-made-up"/);
  });

  it("reports unrecognised data types in produces and consumes", () => {
    const errors = capabilityNameErrors({
      produces: [{ type: "unknown-thing" }],
      consumes: [{ type: "another-unknown" }],
    });
    expect(errors.map((error) => error.split(":")[0])).toEqual([
      "produces[0].type",
      "consumes[0].type",
    ]);
  });
});

describe("validateServiceManifest — capability names", () => {
  const baseManifest = {
    id: "myservice",
    name: "My Service",
    version: "1.0.0",
    platform: "1.0",
    quality: "community" as const,
    container: { image: "owner/image", tag: "latest", expose: [80], memory: "256m" },
  };

  // A community-tier fixture — validate it the way the registry validates a
  // manifest discovered in a cloned repo.
  const validateCommunity = (raw: unknown) => validateServiceManifest(raw, { firstParty: false });

  it("refuses a community manifest with an un-namespaced capability", () => {
    const result = validateCommunity({ ...baseManifest, provides: ["myroutingthing"] });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"myroutingthing"');
  });

  it("accepts well-known and namespaced capabilities", () => {
    expect(
      validateCommunity({ ...baseManifest, provides: ["routing-engine", "vendor/extra-thing"] }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("accepts the structured `provides` form with metadata", () => {
    const result = validateCommunity({
      ...baseManifest,
      provides: [
        {
          capability: "routing-engine",
          metadata: { region: "europe", bbox: [-25, 35, 45, 72] },
        },
      ],
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("refuses the structured form when the capability is unrecognised", () => {
    const result = validateCommunity({
      ...baseManifest,
      provides: [{ capability: "weird-thing", metadata: { foo: "bar" } }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('"weird-thing"');
  });

  it("accepts a mix of bare strings and structured entries on the same service", () => {
    const result = validateCommunity({
      ...baseManifest,
      provides: ["routing-engine", { capability: "tile-server", metadata: { region: "europe" } }],
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("leaves built-in capability names to review", () => {
    const { platform: _, ...builtIn } = baseManifest;
    expect(
      validateServiceManifest(
        { ...builtIn, quality: "built-in", provides: ["myroutingthing"] },
        { firstParty: true },
      ).valid,
    ).toBe(true);
  });
});
