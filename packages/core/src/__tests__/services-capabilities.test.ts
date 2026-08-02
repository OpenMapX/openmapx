import { describe, expect, it } from "vitest";
import {
  checkCapabilityName,
  collectCapabilityWarnings,
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

describe("collectCapabilityWarnings", () => {
  it("returns no warnings for an all-well-known manifest", () => {
    const warnings = collectCapabilityWarnings({
      id: "valhalla",
      provides: ["routing-engine"],
      produces: [{ type: "osm-pbf" }],
      consumes: [{ type: "gtfs" }],
    });
    expect(warnings).toEqual([]);
  });

  it("returns no warnings for a namespaced community capability", () => {
    const warnings = collectCapabilityWarnings({
      id: "acme-thing",
      provides: ["acme/super-router"],
      produces: [{ type: "acme/proprietary-blob" }],
    });
    expect(warnings).toEqual([]);
  });

  it("warns on an unrecognised capability with the right path", () => {
    const warnings = collectCapabilityWarnings({
      id: "weird",
      provides: ["routing-engine", "totally-made-up"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("provides[1]");
    expect(warnings[0]?.value).toBe("totally-made-up");
    expect(warnings[0]?.kind).toBe("capability");
  });

  it("warns on an unrecognised data type in produces / consumes", () => {
    const warnings = collectCapabilityWarnings({
      id: "weird",
      produces: [{ type: "unknown-thing" }],
      consumes: [{ type: "another-unknown" }],
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.path).sort()).toEqual(["consumes[0].type", "produces[0].type"]);
  });
});

describe("validateServiceManifest — capability warnings", () => {
  const baseManifest = {
    id: "myservice",
    name: "My Service",
    version: "1.0.0",
    quality: "community" as const,
    container: { image: "owner/image", tag: "latest", expose: [80] },
  };

  // A community-tier fixture — validate it the way the registry validates a
  // manifest discovered in a cloned repo.
  const validateCommunity = (raw: unknown) => validateServiceManifest(raw, { firstParty: false });

  it("attaches warnings to the validation result without making it invalid", () => {
    const result = validateCommunity({
      ...baseManifest,
      provides: ["myroutingthing"],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]?.value).toBe("myroutingthing");
  });

  it("omits warnings entirely when everything is well-known or namespaced", () => {
    const result = validateCommunity({
      ...baseManifest,
      provides: ["routing-engine", "vendor/extra-thing"],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeUndefined();
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
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  it("warns on the structured form when the capability is unrecognised", () => {
    const result = validateCommunity({
      ...baseManifest,
      provides: [{ capability: "weird-thing", metadata: { foo: "bar" } }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]?.value).toBe("weird-thing");
  });

  it("accepts a mix of bare strings and structured entries on the same service", () => {
    const result = validateCommunity({
      ...baseManifest,
      provides: ["routing-engine", { capability: "tile-server", metadata: { region: "europe" } }],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
